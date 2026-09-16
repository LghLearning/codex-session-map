import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Session, SessionProvider, SessionProviderUpdate, Turn } from "../../../packages/core/src/index.ts";
import { preferredSessionDisplayTitle, semanticInputFingerprint, type SqliteSemanticTraceStore } from "../../../packages/semantic-store/src/index.ts";

export type SearchSourceKind = "session_title" | "turn_label" | "turn_summary" | "user_input" | "assistant_final";

export interface SearchIndexStatus {
  readonly state: "idle" | "indexing" | "ready" | "error";
  /** Persisted documents have been checked against current source metadata. */
  readonly freshness?: "verified" | "unverified" | "stale";
  readonly totalSessions: number;
  readonly indexedSessions: number;
  readonly indexedTurns: number;
  readonly coverage: number;
  readonly updatedAt?: string;
  readonly error?: string;
}

export interface WorkspaceSearchResult {
  readonly sessionId: string;
  readonly nativeTurnId?: string;
  readonly displayOrdinal?: number;
  readonly sessionTitle: string;
  readonly timestamp?: string;
  readonly sourceKind: SearchSourceKind;
  readonly snippet: string;
  readonly highlights: readonly { start: number; end: number }[];
}

export interface WorkspaceSearchPage {
  readonly query: string;
  readonly results: readonly WorkspaceSearchResult[];
  readonly nextCursor?: string;
  readonly mode: "fts5_trigram" | "substring_fallback";
  readonly index: SearchIndexStatus;
}

export interface WorkspaceSearchPort {
  start(workspaceId: string): void;
  status(workspaceId: string): SearchIndexStatus;
  query(workspaceId: string, query: string, options?: { limit?: number; cursor?: string; sourceKinds?: readonly SearchSourceKind[] }): WorkspaceSearchPage;
  refreshSession(sessionId: string): void;
  removeSessionDocuments(sessionId: string): void;
  reconcileUpdate(update: SessionProviderUpdate): void;
  reconcile(): void;
  close(): Promise<void>;
}

export interface SearchIndexDiagnostics {
  readonly fullReconciliations: number;
  readonly refreshedSessions: number;
  readonly skippedSessions: number;
  readonly removedSessions: number;
}

interface SearchSemanticSource {
  getSessionTitle(providerId: string, sessionId: string): ReturnType<SqliteSemanticTraceStore["getSessionTitle"]>;
  listSession(providerId: string, sessionId: string): ReturnType<SqliteSemanticTraceStore["listSession"]>;
  getUserFeedback(identity: { providerId: string; sessionId: string; nativeTurnId: string }): ReturnType<SqliteSemanticTraceStore["getUserFeedback"]>;
  readonly overrides: Pick<SqliteSemanticTraceStore["overrides"], "list">;
}

export class WorkspaceSearchIndex implements WorkspaceSearchPort {
  readonly #db: DatabaseSync;
  readonly #provider: SessionProvider;
  readonly #semantic?: SearchSemanticSource;
  readonly #running = new Map<string, Promise<void>>();
  readonly #started = new Set<string>();
  readonly #refreshing = new Set<Promise<unknown>>();
  readonly #diagnostics = { fullReconciliations: 0, refreshedSessions: 0, skippedSessions: 0, removedSessions: 0 };

  constructor(options: { databasePath?: string; provider: SessionProvider; semantic?: SearchSemanticSource }) {
    this.#provider = options.provider;
    this.#semantic = options.semantic;
    this.#db = new DatabaseSync(options.databasePath ?? ":memory:");
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS search_documents (
        doc_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        native_turn_id TEXT,
        display_ordinal INTEGER,
        session_title TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_timestamp TEXT,
        normalized_text TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS search_documents_workspace ON search_documents(workspace_id, session_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
        doc_id UNINDEXED,
        normalized_text,
        tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS search_workspace_status (
        workspace_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        freshness TEXT NOT NULL DEFAULT 'unverified',
        total_sessions INTEGER NOT NULL DEFAULT 0,
        indexed_sessions INTEGER NOT NULL DEFAULT 0,
        indexed_turns INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS search_session_state (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        raw_source_stamp TEXT,
        semantic_source_stamp TEXT,
        verification_state TEXT NOT NULL DEFAULT 'unverified',
        indexed_turns INTEGER NOT NULL
      );
    `);
    ensureColumn(this.#db, "search_workspace_status", "freshness", "TEXT NOT NULL DEFAULT 'unverified'");
    ensureColumn(this.#db, "search_session_state", "raw_source_stamp", "TEXT");
    ensureColumn(this.#db, "search_session_state", "semantic_source_stamp", "TEXT");
    ensureColumn(this.#db, "search_session_state", "verification_state", "TEXT NOT NULL DEFAULT 'unverified'");
  }

  start(workspaceId: string): void {
    if (!workspaceId || this.#running.has(workspaceId) || this.#started.has(workspaceId)) return;
    this.#started.add(workspaceId);
    this.#schedule(workspaceId);
  }

  status(workspaceId: string): SearchIndexStatus {
    const row = this.#db.prepare("SELECT * FROM search_workspace_status WHERE workspace_id=?").get(workspaceId) as StatusRow | undefined;
    if (!row) return { state: "idle", freshness: "unverified", totalSessions: 0, indexedSessions: 0, indexedTurns: 0, coverage: 0 };
    return projectStatus(row);
  }

  diagnostics(): SearchIndexDiagnostics { return { ...this.#diagnostics }; }

  query(workspaceId: string, rawQuery: string, options: { limit?: number; cursor?: string; sourceKinds?: readonly SearchSourceKind[] } = {}): WorkspaceSearchPage {
    this.start(workspaceId);
    const query = normalizeQuery(rawQuery);
    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 20)));
    const offset = decodeCursor(options.cursor);
    const kinds = options.sourceKinds?.filter(isSourceKind) ?? [];
    if (!query) return { query, results: [], mode: "substring_fallback", index: this.status(workspaceId) };
    const short = [...query].length < 3;
    const values = short
      ? this.#substringResults(workspaceId, query, kinds, limit + 1, offset)
      : this.#ftsResults(workspaceId, query, kinds, limit + 1, offset);
    const hasMore = values.length > limit;
    return {
      query,
      results: values.slice(0, limit),
      nextCursor: hasMore ? encodeCursor(offset + limit) : undefined,
      mode: short ? "substring_fallback" : "fts5_trigram",
      index: this.status(workspaceId),
    };
  }

  refreshSession(sessionId: string): void {
    const task = this.#provider.readSession(sessionId)
      .then((session) => this.#indexSession(session))
      .catch(async (error) => {
        const session = await this.#provider.readSession(sessionId).catch(() => undefined);
        this.#markSessionUnverified(sessionId, error instanceof Error ? error.message : "Search verification failed.");
        if (session) this.#markWorkspaceFreshness(session.workspaceScopeId, "stale", error instanceof Error ? error.message : "Search verification failed.");
      })
      .finally(() => this.#refreshing.delete(task));
    this.#refreshing.add(task);
  }

  removeSessionDocuments(sessionId: string): void { this.#diagnostics.removedSessions += 1; this.#deleteSession(undefined, sessionId); }

  reconcileUpdate(update: SessionProviderUpdate): void {
    const scoped = update.affectedSessionIds !== undefined || update.deletedSessionIds !== undefined;
    if (!scoped) return this.reconcile();
    for (const sessionId of update.deletedSessionIds ?? []) this.removeSessionDocuments(sessionId);
    for (const sessionId of update.affectedSessionIds ?? []) this.refreshSession(sessionId);
  }

  reconcile(): void { for (const workspaceId of this.#started) this.#schedule(workspaceId); }

  async close(): Promise<void> { await Promise.allSettled([...this.#running.values(), ...this.#refreshing]); this.#db.close(); }

  #schedule(workspaceId: string): void {
    if (this.#running.has(workspaceId)) return;
    const task = this.#build(workspaceId).finally(() => this.#running.delete(workspaceId));
    this.#running.set(workspaceId, task);
  }

  async #build(workspaceId: string): Promise<void> {
    this.#diagnostics.fullReconciliations += 1;
    const existing = this.status(workspaceId);
    this.#writeStatus(workspaceId, { ...existing, state: "indexing", freshness: existing.freshness ?? "unverified", error: undefined });
    try {
      const sessions = await listAllSessions(this.#provider, workspaceId);
      this.#writeStatus(workspaceId, { state: "indexing", freshness: "unverified", totalSessions: sessions.length, indexedSessions: 0, indexedTurns: 0, coverage: 0 });
      let indexedSessions = 0, indexedTurns = 0;
      let verificationFailures = 0;
      let firstVerificationError: string | undefined;
      for (const session of sessions) {
        try { indexedTurns += await this.#indexSession(session); }
        catch (error) {
          verificationFailures += 1;
          firstVerificationError ??= error instanceof Error ? error.message : "Search verification failed.";
          this.#markSessionUnverified(session.providerSessionId, firstVerificationError);
        }
        indexedSessions += 1;
        this.#writeStatus(workspaceId, { state: "indexing", freshness: "unverified", totalSessions: sessions.length, indexedSessions, indexedTurns, coverage: sessions.length ? indexedSessions / sessions.length : 1, ...(firstVerificationError ? { error: firstVerificationError } : {}) });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const ids = new Set(sessions.map((session) => session.providerSessionId));
      const stale = this.#db.prepare("SELECT DISTINCT session_id FROM search_documents WHERE workspace_id=?").all(workspaceId) as unknown as { session_id: string }[];
      for (const row of stale) if (!ids.has(row.session_id)) this.#deleteSession(workspaceId, row.session_id);
      this.#writeStatus(workspaceId, { state: "ready", freshness: verificationFailures ? "unverified" : "verified", totalSessions: sessions.length, indexedSessions, indexedTurns, coverage: 1, ...(firstVerificationError ? { error: firstVerificationError } : {}) });
    } catch (error) {
      const current = this.status(workspaceId);
      this.#writeStatus(workspaceId, { ...current, state: "error", freshness: "stale", error: error instanceof Error ? error.message : "Search indexing failed." });
    }
  }

  async #indexSession(session: Session): Promise<number> {
    const rawSourceStamp = await this.#provider.getSessionSourceStamp?.(session.providerSessionId);
    const semantic = await this.#readSemantic(session);
    const current = this.#db.prepare("SELECT source_fingerprint,indexed_turns,raw_source_stamp,semantic_source_stamp,verification_state,workspace_id FROM search_session_state WHERE session_id=?").get(session.providerSessionId) as SearchStateRow | undefined;
    if (current && current.workspace_id === session.workspaceScopeId && current.verification_state === "verified" && rawSourceStamp && current.raw_source_stamp === rawSourceStamp && current.semantic_source_stamp === semantic.stamp) {
      this.#diagnostics.skippedSessions += 1;
      return current.indexed_turns;
    }
    const turns = await listAllTurns(this.#provider, session.providerSessionId);
    const semanticTitle = semantic.title;
    const displayTitle = preferredSessionDisplayTitle(session.title, semanticTitle);
    const traces = semantic.traces;
    const labels = semantic.labels;
    const documents: SearchDocument[] = [{
      docId: documentId(session.providerSessionId, undefined, "session_title"), workspaceId: session.workspaceScopeId,
      sessionId: session.providerSessionId, sessionTitle: displayTitle, sourceKind: "session_title", timestamp: session.updatedAt,
      text: displayTitle === session.title ? session.title : `${displayTitle}\n${session.title}`,
    }];
    for (const turn of turns) {
      const common = { workspaceId: session.workspaceScopeId, sessionId: session.providerSessionId, nativeTurnId: turn.nativeTurnId, displayOrdinal: turn.displayOrdinal, sessionTitle: displayTitle, timestamp: turn.completedAt ?? turn.startedAt ?? session.updatedAt };
      const userLabel = labels.get(turn.nativeTurnId);
      if (userLabel) documents.push({ ...common, docId: documentId(session.providerSessionId, turn.nativeTurnId, "turn_label"), sourceKind: "turn_label", text: userLabel });
      const trace = traces.get(turn.nativeTurnId);
      if (trace?.inputFingerprint === semanticInputFingerprint(turn)) {
        const feedback = semantic.feedback?.get(trace.nativeTurnId);
        if (feedback?.verdict !== "rejected") documents.push({ ...common, docId: documentId(session.providerSessionId, turn.nativeTurnId, "turn_summary"), sourceKind: "turn_summary", text: feedback?.editedText ?? trace.text });
      }
      if (turn.input.text) documents.push({ ...common, docId: documentId(session.providerSessionId, turn.nativeTurnId, "user_input"), sourceKind: "user_input", text: turn.input.text });
      if (turn.assistantFinal) documents.push({ ...common, docId: documentId(session.providerSessionId, turn.nativeTurnId, "assistant_final"), sourceKind: "assistant_final", text: turn.assistantFinal });
    }
    const sourceFingerprint = fingerprint(documents.map((document) => `${document.docId}\0${normalizeText(document.text)}`).join("\n"));
    if (current?.source_fingerprint === sourceFingerprint && current.raw_source_stamp === (rawSourceStamp ?? null) && current.semantic_source_stamp === semantic.stamp && current.verification_state === "verified") { this.#diagnostics.skippedSessions += 1; return current.indexed_turns; }
    this.#replaceSession(session.workspaceScopeId, session.providerSessionId, documents);
    this.#diagnostics.refreshedSessions += 1;
    this.#db.prepare(`INSERT INTO search_session_state(session_id,workspace_id,source_fingerprint,raw_source_stamp,semantic_source_stamp,verification_state,indexed_turns) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET workspace_id=excluded.workspace_id,source_fingerprint=excluded.source_fingerprint,raw_source_stamp=excluded.raw_source_stamp,semantic_source_stamp=excluded.semantic_source_stamp,verification_state=excluded.verification_state,indexed_turns=excluded.indexed_turns`)
      .run(session.providerSessionId, session.workspaceScopeId, sourceFingerprint, rawSourceStamp ?? null, semantic.stamp, "verified", turns.length);
    return turns.length;
  }

  async #readSemantic(session: Session): Promise<SemanticSnapshot> {
    if (!this.#semantic) return { title: undefined, traces: new Map(), labels: new Map(), stamp: fingerprint("semantic:none") };
    const title = await this.#semantic.getSessionTitle(session.providerId, session.providerSessionId);
    const traceRows = await this.#semantic.listSession(session.providerId, session.providerSessionId);
    const traces = new Map(traceRows.map((trace) => [trace.nativeTurnId, trace]));
    const feedback = new Map<string, Awaited<ReturnType<SearchSemanticSource["getUserFeedback"]>>>();
    for (const trace of traceRows) feedback.set(trace.nativeTurnId, await this.#semantic.getUserFeedback(trace));
    const labels = new Map((this.#semantic.overrides.list(session.providerId, "label", session.providerSessionId) ?? [])
      .flatMap((item) => item.nativeTurnId && item.value?.label ? [[item.nativeTurnId, item.value.label] as const] : []));
    const stamp = fingerprint(JSON.stringify({
      title: title ?? null,
      traces: traceRows.map((trace) => ({ id: trace.nativeTurnId, text: trace.text, input: trace.inputFingerprint, generator: trace.generator, feedback: feedback.get(trace.nativeTurnId) ?? null })),
      labels: [...labels.entries()],
    }));
    return { title, traces, labels, feedback, stamp };
  }

  #markSessionUnverified(sessionId: string, error?: string): void {
    this.#db.prepare("UPDATE search_session_state SET raw_source_stamp=NULL, semantic_source_stamp=NULL, verification_state='unverified' WHERE session_id=?").run(sessionId);
    void error;
  }

  #markWorkspaceFreshness(workspaceId: string, freshness: SearchIndexStatus["freshness"], error?: string): void {
    const current = this.status(workspaceId);
    this.#writeStatus(workspaceId, { ...current, state: current.state === "idle" ? "ready" : current.state, freshness, ...(error ? { error } : {}) });
  }

  #replaceSession(workspaceId: string, sessionId: string, documents: readonly SearchDocument[]): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#deleteSession(undefined, sessionId);
      const insert = this.#db.prepare(`INSERT INTO search_documents
        (doc_id,workspace_id,session_id,native_turn_id,display_ordinal,session_title,source_kind,source_timestamp,normalized_text,source_fingerprint)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const insertFts = this.#db.prepare("INSERT INTO search_documents_fts(doc_id,normalized_text) VALUES (?,?)");
      for (const document of documents) {
        const text = normalizeText(document.text);
        if (!text) continue;
        insert.run(document.docId, workspaceId, sessionId, document.nativeTurnId ?? null, document.displayOrdinal ?? null, document.sessionTitle, document.sourceKind, document.timestamp ?? null, text, fingerprint(text));
        insertFts.run(document.docId, text);
      }
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #deleteSession(workspaceId: string | undefined, sessionId: string): void {
    const ids = (workspaceId
      ? this.#db.prepare("SELECT doc_id FROM search_documents WHERE workspace_id=? AND session_id=?").all(workspaceId, sessionId)
      : this.#db.prepare("SELECT doc_id FROM search_documents WHERE session_id=?").all(sessionId)) as unknown as { doc_id: string }[];
    const removeFts = this.#db.prepare("DELETE FROM search_documents_fts WHERE doc_id=?");
    for (const row of ids) removeFts.run(row.doc_id);
    if (workspaceId) this.#db.prepare("DELETE FROM search_documents WHERE workspace_id=? AND session_id=?").run(workspaceId, sessionId);
    else this.#db.prepare("DELETE FROM search_documents WHERE session_id=?").run(sessionId);
    this.#db.prepare("DELETE FROM search_session_state WHERE session_id=?").run(sessionId);
  }

  #ftsResults(workspaceId: string, query: string, kinds: readonly SearchSourceKind[], limit: number, offset: number): WorkspaceSearchResult[] {
    const kindSql = kinds.length ? ` AND d.source_kind IN (${kinds.map(() => "?").join(",")})` : "";
    const rows = this.#db.prepare(`SELECT d.*, snippet(search_documents_fts,1,char(57344),char(57345),'…',20) AS snippet
      FROM search_documents_fts JOIN search_documents d ON d.doc_id=search_documents_fts.doc_id
      WHERE search_documents_fts MATCH ? AND d.workspace_id=?${kindSql}
      ORDER BY CASE d.source_kind WHEN 'session_title' THEN 0 WHEN 'turn_label' THEN 1 WHEN 'turn_summary' THEN 2 ELSE 3 END,
        bm25(search_documents_fts), d.source_timestamp DESC LIMIT ? OFFSET ?`)
      .all(quoteFts(query), workspaceId, ...kinds, limit, offset) as unknown as SearchRow[];
    return rows.map((row) => projectResult(row, markedSnippet(row.snippet)));
  }

  #substringResults(workspaceId: string, query: string, kinds: readonly SearchSourceKind[], limit: number, offset: number): WorkspaceSearchResult[] {
    const kindSql = kinds.length ? ` AND source_kind IN (${kinds.map(() => "?").join(",")})` : "";
    const rows = this.#db.prepare(`SELECT * FROM search_documents WHERE workspace_id=? AND instr(lower(normalized_text),lower(?))>0${kindSql}
      ORDER BY CASE source_kind WHEN 'session_title' THEN 0 WHEN 'turn_label' THEN 1 WHEN 'turn_summary' THEN 2 ELSE 3 END,
        source_timestamp DESC LIMIT ? OFFSET ?`).all(workspaceId, query, ...kinds, limit, offset) as unknown as SearchRow[];
    return rows.map((row) => projectResult(row, substringSnippet(row.normalized_text, query)));
  }

  #writeStatus(workspaceId: string, status: SearchIndexStatus): void {
    this.#db.prepare(`INSERT INTO search_workspace_status(workspace_id,state,freshness,total_sessions,indexed_sessions,indexed_turns,updated_at,error)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET state=excluded.state,freshness=excluded.freshness,total_sessions=excluded.total_sessions,
      indexed_sessions=excluded.indexed_sessions,indexed_turns=excluded.indexed_turns,updated_at=excluded.updated_at,error=excluded.error`)
      .run(workspaceId, status.state, status.freshness ?? "unverified", status.totalSessions, status.indexedSessions, status.indexedTurns, new Date().toISOString(), status.error ?? null);
  }
}

interface SearchDocument { docId: string; workspaceId: string; sessionId: string; nativeTurnId?: string; displayOrdinal?: number; sessionTitle: string; sourceKind: SearchSourceKind; timestamp?: string; text: string }
interface SearchRow { session_id: string; native_turn_id: string | null; display_ordinal: number | null; session_title: string; source_kind: SearchSourceKind; source_timestamp: string | null; normalized_text: string; snippet: string }
interface SearchStateRow { source_fingerprint: string; indexed_turns: number; raw_source_stamp: string | null; semantic_source_stamp: string | null; verification_state: "verified" | "unverified" | "stale"; workspace_id: string }
interface StatusRow { state: SearchIndexStatus["state"]; freshness: SearchIndexStatus["freshness"]; total_sessions: number; indexed_sessions: number; indexed_turns: number; updated_at: string | null; error: string | null }
interface SemanticSnapshot {
  readonly title?: Awaited<ReturnType<SqliteSemanticTraceStore["getSessionTitle"]>>;
  readonly traces: ReadonlyMap<string, Awaited<ReturnType<SqliteSemanticTraceStore["listSession"]>>[number]>;
  readonly labels: ReadonlyMap<string, string>;
  readonly feedback?: ReadonlyMap<string, Awaited<ReturnType<SearchSemanticSource["getUserFeedback"]>>>;
  readonly stamp: string;
}

function projectStatus(row: StatusRow): SearchIndexStatus {
  return { state: row.state, freshness: row.freshness ?? "unverified", totalSessions: row.total_sessions, indexedSessions: row.indexed_sessions, indexedTurns: row.indexed_turns, coverage: row.total_sessions ? row.indexed_sessions / row.total_sessions : row.state === "ready" ? 1 : 0, updatedAt: row.updated_at ?? undefined, error: row.error ?? undefined };
}
function projectResult(row: SearchRow, value: { text: string; highlights: { start: number; end: number }[] }): WorkspaceSearchResult {
  return { sessionId: row.session_id, nativeTurnId: row.native_turn_id ?? undefined, displayOrdinal: row.display_ordinal ?? undefined, sessionTitle: row.session_title, timestamp: row.source_timestamp ?? undefined, sourceKind: row.source_kind, snippet: value.text, highlights: value.highlights };
}
function markedSnippet(value: string): { text: string; highlights: { start: number; end: number }[] } {
  let text = "", start: number | undefined; const highlights: { start: number; end: number }[] = [];
  for (const char of value) {
    if (char === "\uE000") start = text.length;
    else if (char === "\uE001" && start !== undefined) { highlights.push({ start, end: text.length }); start = undefined; }
    else text += char;
  }
  return { text, highlights };
}
function substringSnippet(text: string, query: string): { text: string; highlights: { start: number; end: number }[] } {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const from = Math.max(0, index - 70), to = Math.min(text.length, index + query.length + 90);
  const snippet = `${from ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
  const start = (from ? 1 : 0) + index - from;
  return { text: snippet, highlights: [{ start, end: start + query.length }] };
}
function quoteFts(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
function normalizeQuery(value: string): string { return value.normalize("NFKC").replace(/\s+/g, " ").trim(); }
function normalizeText(value: string): string { return value.normalize("NFKC").replace(/\u0000/g, "").trim(); }
function fingerprint(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function documentId(sessionId: string, turnId: string | undefined, kind: SearchSourceKind): string { return createHash("sha256").update(`${sessionId}\0${turnId ?? ""}\0${kind}`).digest("hex"); }
function encodeCursor(offset: number): string { return Buffer.from(String(offset), "utf8").toString("base64url"); }
function decodeCursor(value?: string): number { if (!value) return 0; const offset = Number(Buffer.from(value, "base64url").toString("utf8")); return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0; }
function isSourceKind(value: string): value is SearchSourceKind { return ["session_title", "turn_label", "turn_summary", "user_input", "assistant_final"].includes(value); }

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function listAllSessions(provider: SessionProvider, workspaceId: string): Promise<Session[]> {
  const values: Session[] = []; let cursor: string | undefined; const seen = new Set<string>();
  do { const page = await provider.listSessions(workspaceId, cursor); values.push(...page.data.filter((session) => !session.excludedFromMainWorkspaceForest)); if (!page.nextCursor || seen.has(page.nextCursor)) break; seen.add(page.nextCursor); cursor = page.nextCursor; } while (cursor);
  return values;
}
async function listAllTurns(provider: SessionProvider, sessionId: string): Promise<Turn[]> {
  const values: Turn[] = []; let cursor: string | undefined; const seen = new Set<string>();
  do { const page = await provider.listTurns(sessionId, cursor); values.push(...page.data); if (!page.nextCursor || seen.has(page.nextCursor)) break; seen.add(page.nextCursor); cursor = page.nextCursor; } while (cursor);
  return values;
}
