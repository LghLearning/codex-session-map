import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  SemanticGeneratorIdentity,
  SemanticTraceLookup,
  Turn,
  TurnIdentity,
  TurnSemanticTrace,
  SessionProvider,
} from "../../core/src/index.ts";
import type { SemanticParentEdge, SemanticParentRelation, SemanticParentStore } from "./semantic-parent.ts";
import { UserOverrides, migrateUserOverrides } from "./user-overrides.ts";
export * from "./user-overrides.ts";

export * from "./prompt-generator.ts";
export * from "./session-title-generator.ts";
export * from "./ollama-client.ts";
export * from "./semantic-safety.ts";
export * from "./semantic-parent.ts";

export const SEMANTIC_STORE_SCHEMA_VERSION = 5;

export type SemanticTraceUserVerdict = "accepted" | "edited" | "rejected";

/** Authoritative user feedback. Unlike AI traces, this is not disposable derived cache. */
export interface SemanticTraceUserFeedback extends TurnIdentity {
  readonly verdict: SemanticTraceUserVerdict;
  readonly aiOriginalText: string;
  readonly editedText?: string;
  readonly sourceFingerprint: string;
  readonly reviewedAt: string;
}

export interface SemanticSessionTitleTraceInput {
  readonly nativeTurnId: string;
  readonly displayOrdinal: number;
  readonly text: string;
}

export interface SemanticSessionTitleFallbackTurn {
  readonly nativeTurnId: string;
  readonly displayOrdinal: number;
  readonly status: Turn["status"];
  readonly input?: string;
  readonly assistantFinal?: string;
}

/** Public, provider-neutral input for a manually generated Session title. */
export interface SemanticSessionTitleSource {
  readonly providerId: string;
  readonly sessionId: string;
  readonly originalTitle: string;
  readonly firstUserInput?: string;
  readonly semanticTraces: readonly SemanticSessionTitleTraceInput[];
  readonly fallbackTurns: readonly SemanticSessionTitleFallbackTurn[];
  /** Full public source fingerprint, independent of the sampled title prompt. */
  readonly sourceContentFingerprint?: string;
}

export interface GeneratedSemanticSessionTitle {
  readonly title: string;
}

export interface SemanticGenerationOptions {
  readonly signal?: AbortSignal;
  /** Checked immediately before derived data is committed. */
  readonly mayCommit?: () => boolean;
  readonly onMetrics?: (metrics: SemanticGenerationMetrics) => void;
}

export interface SemanticGenerationMetrics {
  readonly inputChars?: number;
  readonly modelMs?: number;
  readonly validationMs?: number;
  readonly commitMs?: number;
  readonly retryCount?: number;
}

export interface SemanticSessionTitleGenerator {
  readonly identity: SemanticGeneratorIdentity;
  generate(source: SemanticSessionTitleSource, options?: SemanticGenerationOptions): Promise<GeneratedSemanticSessionTitle>;
}

export interface SemanticSessionTitle {
  readonly providerId: string;
  readonly sessionId: string;
  readonly generatedTitle?: string;
  readonly userTitle?: string;
  readonly generator?: SemanticGeneratorIdentity;
  readonly sourceFingerprint?: string;
  readonly generatedAt?: string;
  readonly userEditedAt?: string;
}

export interface SemanticSessionTitleLookup {
  readonly freshness: "missing" | "current" | "stale";
  readonly title?: SemanticSessionTitle;
  readonly currentSourceFingerprint: string;
}

export interface DerivedStoreLifecycle {
  readonly schemaVersion: number;
  close(): Promise<void>;
}

export interface GeneratedSemanticTrace {
  readonly text: string;
}

export interface TurnSemanticTraceGenerator {
  readonly identity: SemanticGeneratorIdentity;
  generate(turn: Turn, options?: SemanticGenerationOptions): Promise<GeneratedSemanticTrace>;
}

export interface SemanticTraceStore extends DerivedStoreLifecycle, SemanticParentStore {
  get(identity: TurnIdentity): Promise<TurnSemanticTrace | undefined>;
  listSession(providerId: string, sessionId: string): Promise<readonly TurnSemanticTrace[]>;
  put(trace: TurnSemanticTrace): Promise<void>;
  getUserFeedback(identity: TurnIdentity): Promise<SemanticTraceUserFeedback | undefined>;
  putUserFeedback(feedback: SemanticTraceUserFeedback): Promise<void>;
  getSessionTitle(providerId: string, sessionId: string): Promise<SemanticSessionTitle | undefined>;
  putGeneratedSessionTitle(title: SemanticSessionTitle): Promise<void>;
  putUserSessionTitle(providerId: string, sessionId: string, userTitle: string, userEditedAt: string): Promise<void>;
}

export class SqliteSemanticTraceStore implements SemanticTraceStore {
  readonly schemaVersion = SEMANTIC_STORE_SCHEMA_VERSION;
  readonly #database: DatabaseSync;
  readonly overrides: UserOverrides;

  constructor(databasePath = ":memory:") {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON");
    try { this.#migrate(); }
    catch (error) { this.#database.close(); throw error; }
    this.overrides = new UserOverrides(this.#database);
  }

  async get(identity: TurnIdentity): Promise<TurnSemanticTrace | undefined> {
    const row = this.#database.prepare(`
      SELECT provider_id, session_id, native_turn_id, trace_text, input_fingerprint,
             generator_id, generator_version, generator_model, generated_at
      FROM turn_semantic_traces
      WHERE provider_id = ? AND session_id = ? AND native_turn_id = ?
    `).get(identity.providerId, identity.sessionId, identity.nativeTurnId) as TraceRow | undefined;
    return row ? projectRow(row) : undefined;
  }

  async listSession(providerId: string, sessionId: string): Promise<readonly TurnSemanticTrace[]> {
    const rows = this.#database.prepare(`
      SELECT provider_id, session_id, native_turn_id, trace_text, input_fingerprint,
             generator_id, generator_version, generator_model, generated_at
      FROM turn_semantic_traces
      WHERE provider_id = ? AND session_id = ?
      ORDER BY generated_at, native_turn_id
    `).all(providerId, sessionId) as unknown as TraceRow[];
    return rows.map(projectRow);
  }

  async put(trace: TurnSemanticTrace): Promise<void> {
    this.#database.prepare(`
      INSERT INTO turn_semantic_traces (
        provider_id, session_id, native_turn_id, trace_text, input_fingerprint,
        generator_id, generator_version, generator_model, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, session_id, native_turn_id) DO UPDATE SET
        trace_text = excluded.trace_text,
        input_fingerprint = excluded.input_fingerprint,
        generator_id = excluded.generator_id,
        generator_version = excluded.generator_version,
        generator_model = excluded.generator_model,
        generated_at = excluded.generated_at
    `).run(
      trace.providerId,
      trace.sessionId,
      trace.nativeTurnId,
      normalizeTraceText(trace.text),
      trace.inputFingerprint,
      trace.generator.id,
      trace.generator.version,
      trace.generator.model ?? null,
      trace.generatedAt,
    );
  }

  async getUserFeedback(identity: TurnIdentity): Promise<SemanticTraceUserFeedback | undefined> {
    const key = { providerId: identity.providerId, sessionId: identity.sessionId, nativeTurnId: identity.nativeTurnId };
    const override = this.overrides.read({ ...key, field: "label" });
    if (override) {
      const feedback = override.value?.feedback;
      if (feedback) return { ...key, ...feedback, editedText: override.value?.label ?? feedback.editedText };
      return override.value?.label ? { ...key, verdict: "edited", editedText: override.value.label, aiOriginalText: "", sourceFingerprint: "", reviewedAt: override.updatedAt } : undefined;
    }
    const row = this.#database.prepare(`
      SELECT provider_id, session_id, native_turn_id, verdict, ai_original_text,
             edited_text, source_fingerprint, reviewed_at
      FROM turn_semantic_trace_feedback
      WHERE provider_id = ? AND session_id = ? AND native_turn_id = ?
    `).get(identity.providerId, identity.sessionId, identity.nativeTurnId) as FeedbackRow | undefined;
    return row ? projectFeedbackRow(row) : undefined;
  }

  async putUserFeedback(feedback: SemanticTraceUserFeedback): Promise<void> {
    const editedText = feedback.verdict === "edited"
      ? normalizeTraceText(feedback.editedText ?? "")
      : undefined;
    this.overrides.write({ providerId: feedback.providerId, sessionId: feedback.sessionId, nativeTurnId: feedback.nativeTurnId, field: "label" }, "", {
      label: editedText,
      feedback: { verdict: feedback.verdict, aiOriginalText: normalizeTraceText(feedback.aiOriginalText), editedText, sourceFingerprint: feedback.sourceFingerprint, reviewedAt: feedback.reviewedAt },
    });

  }

  async getSessionTitle(providerId: string, sessionId: string): Promise<SemanticSessionTitle | undefined> {
    const row = this.#database.prepare(`
      SELECT provider_id, session_id, generated_title, user_title, generator_id,
             generator_version, generator_model, source_fingerprint, generated_at, user_edited_at
      FROM session_semantic_titles
      WHERE provider_id = ? AND session_id = ?
    `).get(providerId, sessionId) as SessionTitleRow | undefined;
    const override = this.overrides.read({ providerId, sessionId, field: "title" });
    if (!row && !override?.value?.title) return undefined;
    return { ...(row ? projectSessionTitleRow(row) : { providerId, sessionId }), userTitle: override?.value?.title, userEditedAt: override?.value ? override.updatedAt : undefined };
  }

  async putGeneratedSessionTitle(title: SemanticSessionTitle): Promise<void> {
    this.#database.prepare(`
      INSERT INTO session_semantic_titles (
        provider_id, session_id, generated_title, user_title, generator_id,
        generator_version, generator_model, source_fingerprint, generated_at, user_edited_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(provider_id, session_id) DO UPDATE SET
        generated_title = excluded.generated_title,
        generator_id = excluded.generator_id,
        generator_version = excluded.generator_version,
        generator_model = excluded.generator_model,
        source_fingerprint = excluded.source_fingerprint,
        generated_at = excluded.generated_at
    `).run(
      title.providerId,
      title.sessionId,
      normalizeSemanticSessionTitle(title.generatedTitle ?? ""),
      title.generator!.id,
      title.generator!.version,
      title.generator!.model ?? null,
      title.sourceFingerprint,
      title.generatedAt,
    );
  }

  async putUserSessionTitle(providerId: string, sessionId: string, userTitle: string, userEditedAt: string): Promise<void> {
    this.overrides.write({ providerId, sessionId, field: "title" }, "", { title: normalizeSemanticSessionTitle(userTitle) });
  }

  async getSemanticParent(providerId: string, childSessionId: string): Promise<SemanticParentEdge | undefined> {
    const row = this.#database.prepare(`
      SELECT provider_id, child_session_id, generated_parent_session_id, generated_relation,
             generated_reason, generator_id, generator_version, generator_model,
             source_fingerprint, generated_at, user_parent_session_id, user_relation, user_reviewed_at
      FROM session_semantic_edges
      WHERE provider_id = ? AND child_session_id = ?
    `).get(providerId, childSessionId) as SemanticParentRow | undefined;
    const override = this.overrides.read({ providerId, sessionId: childSessionId, field: "parent" });
    if (!row && !override?.value?.relation) return undefined;
    return { ...(row ? projectSemanticParentRow(row) : { providerId, childSessionId }), userRelation: override?.value?.relation, userParentSessionId: override?.value?.parentSessionId, userAnchorTurnId: override?.value?.anchorTurnId, userReviewedAt: override?.value ? override.updatedAt : undefined };
  }

  async listSemanticParents(providerId: string): Promise<readonly SemanticParentEdge[]> {
    const rows = this.#database.prepare(`
      SELECT provider_id, child_session_id, generated_parent_session_id, generated_relation,
             generated_reason, generator_id, generator_version, generator_model,
             source_fingerprint, generated_at, user_parent_session_id, user_relation, user_reviewed_at
      FROM session_semantic_edges
      WHERE provider_id = ?
      ORDER BY generated_at, child_session_id
    `).all(providerId) as unknown as SemanticParentRow[];
    const ids = new Set([...rows.map((row) => row.child_session_id), ...this.overrides.list(providerId, "parent").map((row) => row.sessionId)]);
    return (await Promise.all([...ids].map((id) => this.getSemanticParent(providerId, id)))).filter((edge) => edge !== undefined);
  }

  async putGeneratedSemanticParent(edge: SemanticParentEdge): Promise<void> {
    this.#database.prepare(`
      INSERT INTO session_semantic_edges (
        provider_id, child_session_id, generated_parent_session_id, generated_relation,
        generated_reason, generator_id, generator_version, generator_model,
        source_fingerprint, generated_at, user_parent_session_id, user_relation, user_reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(provider_id, child_session_id) DO UPDATE SET
        generated_parent_session_id = excluded.generated_parent_session_id,
        generated_relation = excluded.generated_relation,
        generated_reason = excluded.generated_reason,
        generator_id = excluded.generator_id,
        generator_version = excluded.generator_version,
        generator_model = excluded.generator_model,
        source_fingerprint = excluded.source_fingerprint,
        generated_at = excluded.generated_at
    `).run(
      edge.providerId,
      edge.childSessionId,
      edge.generatedParentSessionId ?? null,
      edge.generatedRelation,
      edge.generatedReason,
      edge.generator!.id,
      edge.generator!.version,
      edge.generator!.model ?? null,
      edge.sourceFingerprint,
      edge.generatedAt,
    );
  }

  async putUserSemanticParent(
    providerId: string,
    childSessionId: string,
    parentSessionId: string | undefined,
    relation: SemanticParentRelation,
    reviewedAt: string,
    anchorTurnId?: string,
  ): Promise<void> {
    this.overrides.write({ providerId, sessionId: childSessionId, field: "parent" }, "", { relation, parentSessionId, anchorTurnId });
  }

  async close(): Promise<void> {
    this.#database.close();
  }

  #migrate(): void {
    const version = Number(this.#database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > SEMANTIC_STORE_SCHEMA_VERSION) throw new Error(`Unsupported semantic store schema version: ${version}`);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
    if (version < 1) this.#database.exec(`
      CREATE TABLE IF NOT EXISTS turn_semantic_traces (
        provider_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        native_turn_id TEXT NOT NULL,
        trace_text TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        generator_id TEXT NOT NULL,
        generator_version TEXT NOT NULL,
        generator_model TEXT,
        generated_at TEXT NOT NULL,
        PRIMARY KEY (provider_id, session_id, native_turn_id)
      );
      CREATE INDEX IF NOT EXISTS turn_semantic_traces_session
        ON turn_semantic_traces(provider_id, session_id);
      PRAGMA user_version = 1;
    `);
    if (version < 2) this.#database.exec(`
      CREATE TABLE IF NOT EXISTS turn_semantic_trace_feedback (
        provider_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        native_turn_id TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('accepted', 'edited', 'rejected')),
        ai_original_text TEXT NOT NULL,
        edited_text TEXT,
        source_fingerprint TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        PRIMARY KEY (provider_id, session_id, native_turn_id)
      );
      CREATE INDEX IF NOT EXISTS turn_semantic_trace_feedback_session
        ON turn_semantic_trace_feedback(provider_id, session_id);
      PRAGMA user_version = 2;
    `);
    if (version < 3) this.#database.exec(`
      CREATE TABLE IF NOT EXISTS session_semantic_titles (
        provider_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        generated_title TEXT NOT NULL,
        user_title TEXT,
        generator_id TEXT NOT NULL,
        generator_version TEXT NOT NULL,
        generator_model TEXT,
        source_fingerprint TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        user_edited_at TEXT,
        PRIMARY KEY (provider_id, session_id)
      );
      PRAGMA user_version = 3;
    `);
    if (version < 4) this.#database.exec(`
      CREATE TABLE IF NOT EXISTS session_semantic_edges (
        provider_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        generated_parent_session_id TEXT,
        generated_relation TEXT NOT NULL CHECK (generated_relation IN ('continuation', 'subtask', 'root')),
        generated_reason TEXT NOT NULL,
        generator_id TEXT NOT NULL,
        generator_version TEXT NOT NULL,
        generator_model TEXT,
        source_fingerprint TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        user_parent_session_id TEXT,
        user_relation TEXT CHECK (user_relation IN ('continuation', 'subtask', 'root')),
        user_reviewed_at TEXT,
        PRIMARY KEY (provider_id, child_session_id),
        CHECK ((generated_relation = 'root' AND generated_parent_session_id IS NULL) OR
               (generated_relation <> 'root' AND generated_parent_session_id IS NOT NULL)),
        CHECK (user_relation IS NULL OR
               (user_relation = 'root' AND user_parent_session_id IS NULL) OR
               (user_relation <> 'root' AND user_parent_session_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS session_semantic_edges_parent
        ON session_semantic_edges(provider_id, generated_parent_session_id);
      PRAGMA user_version = 4;
    `);
    if (version < 5) { migrateUserOverrides(this.#database); this.#database.exec("PRAGMA user_version = 5"); }
    this.#database.exec("COMMIT");
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
}

export class SemanticSessionTitleService {
  readonly #store: SemanticTraceStore;
  readonly #generator: SemanticSessionTitleGenerator;
  readonly #now: () => Date;
  readonly #inflight = new Map<string, Promise<SemanticSessionTitle>>();

  constructor(options: { store: SemanticTraceStore; generator: SemanticSessionTitleGenerator; now?: () => Date }) {
    this.#store = options.store;
    this.#generator = options.generator;
    this.#now = options.now ?? (() => new Date());
  }

  async readStored(providerId: string, sessionId: string): Promise<SemanticSessionTitle | undefined> {
    return this.#store.getSessionTitle(providerId, sessionId);
  }

  async inspect(source: SemanticSessionTitleSource): Promise<SemanticSessionTitleLookup> {
    const currentSourceFingerprint = semanticSessionTitleSourceFingerprint(source);
    const title = await this.#store.getSessionTitle(source.providerId, source.sessionId);
    if (!title?.generatedTitle) return { freshness: "missing", title, currentSourceFingerprint };
    return {
      freshness: title.sourceFingerprint === currentSourceFingerprint && title.generator && sameGenerator(title.generator, this.#generator.identity) ? "current" : "stale",
      title,
      currentSourceFingerprint,
    };
  }

  async generate(source: SemanticSessionTitleSource, options?: SemanticGenerationOptions): Promise<SemanticSessionTitle> {
    const key = `${source.providerId}\u0000${source.sessionId}`;
    const running = this.#inflight.get(key);
    if (running) return running;
    const operation = this.#generate(source, options);
    this.#inflight.set(key, operation);
    try { return await operation; }
    finally { this.#inflight.delete(key); }
  }

  async edit(providerId: string, sessionId: string, userTitle: string): Promise<SemanticSessionTitle> {
    await this.#store.putUserSessionTitle(providerId, sessionId, userTitle, this.#now().toISOString());
    const title = await this.#store.getSessionTitle(providerId, sessionId);
    if (!title) throw new Error("Semantic Session Title was not found after editing.");
    return title;
  }

  async #generate(source: SemanticSessionTitleSource, options?: SemanticGenerationOptions): Promise<SemanticSessionTitle> {
    const generated = await this.#generator.generate(source, options);
    assertGenerationCommitAllowed(options);
    const validationStarted = performance.now();
    const previous = await this.#store.getSessionTitle(source.providerId, source.sessionId);
    const title: SemanticSessionTitle = {
      providerId: source.providerId,
      sessionId: source.sessionId,
      generatedTitle: normalizeSemanticSessionTitle(generated.title),
      userTitle: previous?.userTitle,
      generator: { ...this.#generator.identity },
      sourceFingerprint: semanticSessionTitleSourceFingerprint(source),
      generatedAt: this.#now().toISOString(),
      userEditedAt: previous?.userEditedAt,
    };
    options?.onMetrics?.({ validationMs: performance.now() - validationStarted });
    const commitStarted = performance.now();
    await this.#store.putGeneratedSessionTitle(title);
    options?.onMetrics?.({ commitMs: performance.now() - commitStarted });
    return (await this.#store.getSessionTitle(source.providerId, source.sessionId))!;
  }
}

export class TurnSemanticTraceService {
  readonly #store: SemanticTraceStore;
  readonly #generator: TurnSemanticTraceGenerator;
  readonly #now: () => Date;
  readonly #inflight = new Map<string, Promise<TurnSemanticTrace>>();

  constructor(options: { store: SemanticTraceStore; generator: TurnSemanticTraceGenerator; now?: () => Date }) {
    this.#store = options.store;
    this.#generator = options.generator;
    this.#now = options.now ?? (() => new Date());
  }

  async inspect(turn: Turn): Promise<SemanticTraceLookup> {
    const currentInputFingerprint = semanticInputFingerprint(turn);
    const trace = await this.#store.get(turnIdentity(turn));
    if (!trace) return { freshness: "missing", currentInputFingerprint };
    return {
      freshness: trace.inputFingerprint === currentInputFingerprint && sameGenerator(trace.generator, this.#generator.identity) ? "current" : "stale",
      trace,
      currentInputFingerprint,
    };
  }

  async ensure(turn: Turn, options?: SemanticGenerationOptions): Promise<TurnSemanticTrace> {
    return this.#runGeneration(turn, false, options);
  }

  async regenerate(turn: Turn, options?: SemanticGenerationOptions): Promise<TurnSemanticTrace> {
    return this.#runGeneration(turn, true, options);
  }

  async #runGeneration(turn: Turn, force: boolean, options?: SemanticGenerationOptions): Promise<TurnSemanticTrace> {
    const key = `${turn.providerId}\u0000${turn.sessionId}\u0000${turn.nativeTurnId}`;
    const running = this.#inflight.get(key);
    if (running) return running;
    const operation = this.#generateIfNeeded(turn, force, options);
    this.#inflight.set(key, operation);
    try { return await operation; }
    finally { this.#inflight.delete(key); }
  }

  async #generateIfNeeded(turn: Turn, force: boolean, options?: SemanticGenerationOptions): Promise<TurnSemanticTrace> {
    const lookup = await this.inspect(turn);
    if (!force && lookup.freshness === "current" && lookup.trace) return lookup.trace;
    const generated = await this.#generator.generate(turn, options);
    assertGenerationCommitAllowed(options);
    const validationStarted = performance.now();
    const trace: TurnSemanticTrace = {
      ...turnIdentity(turn),
      text: normalizeTraceText(generated.text),
      inputFingerprint: lookup.currentInputFingerprint,
      generator: { ...this.#generator.identity },
      generatedAt: this.#now().toISOString(),
    };
    options?.onMetrics?.({ validationMs: performance.now() - validationStarted });
    const commitStarted = performance.now();
    await this.#store.put(trace);
    options?.onMetrics?.({ commitMs: performance.now() - commitStarted });
    return trace;
  }
}

export function assertGenerationCommitAllowed(options?: SemanticGenerationOptions): void {
  if (options?.signal?.aborted || options?.mayCommit?.() === false) throw new DOMException("Semantic result was discarded.", "AbortError");
}

export interface SessionTraceIndexResult {
  readonly sessionId: string;
  readonly traces: readonly TurnSemanticTrace[];
  readonly generated: number;
  readonly reused: number;
}

/** Paginated bridge from any SessionProvider to the rebuildable trace service. */
export class SessionSemanticTraceIndexer {
  readonly #provider: Pick<SessionProvider, "listTurns">;
  readonly #service: TurnSemanticTraceService;

  constructor(options: { provider: Pick<SessionProvider, "listTurns">; service: TurnSemanticTraceService }) {
    this.#provider = options.provider;
    this.#service = options.service;
  }

  async indexSession(sessionId: string): Promise<SessionTraceIndexResult> {
    const traces: TurnSemanticTrace[] = [];
    let generated = 0;
    let reused = 0;
    let cursor: string | undefined;
    do {
      const page = await this.#provider.listTurns(sessionId, cursor);
      for (const turn of page.data) {
        const before = await this.#service.inspect(turn);
        traces.push(await this.#service.ensure(turn));
        if (before.freshness === "current") reused += 1;
        else generated += 1;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { sessionId, traces, generated, reused };
  }
}

/** Hashes only public provider-neutral semantic inputs; provenance and ordinals do not invalidate a trace. */
export function semanticInputFingerprint(turn: Turn): string {
  const value = {
    contentVersion: 2,
    initiatorKind: turn.initiatorKind,
    status: turn.status,
    input: turn.input,
    assistantFinal: turn.assistantFinal,
    tools: turn.tools.map((tool) => ({
      callId: tool.callId,
      name: tool.name,
      status: tool.status,
      inputSummary: tool.inputSummary,
      outputSummary: tool.outputSummary,
    })),
    partial: turn.partial,
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Tracks all public Turns, including changes outside a generator's sampling window. */
export function semanticSessionContentFingerprint(turns: readonly Turn[]): string {
  return createHash("sha256").update(JSON.stringify(turns.map((turn) => ({
    nativeTurnId: turn.nativeTurnId,
    content: semanticInputFingerprint(turn),
  })))).digest("hex");
}

export function semanticSessionTitleSourceFingerprint(source: SemanticSessionTitleSource): string {
  return createHash("sha256").update(JSON.stringify({
    contentVersion: 2,
    sourceContentFingerprint: source.sourceContentFingerprint,
    originalTitle: source.originalTitle,
    firstUserInput: source.firstUserInput,
    semanticTraces: source.semanticTraces,
    fallbackTurns: source.semanticTraces.length < 3 ? source.fallbackTurns : [],
  })).digest("hex");
}

export function normalizeTraceText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Semantic Trace text must not be empty.");
  if (normalized.length > 240) throw new Error("Semantic Trace text must not exceed 240 characters.");
  return normalized;
}

export function normalizeSemanticSessionTitle(value: string): string {
  const normalized = value.replace(/^[#\s]+/, "").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Semantic Session Title must not be empty.");
  if (normalized.length > 80) throw new Error("Semantic Session Title must not exceed 80 characters.");
  return normalized;
}

export function preferredSessionDisplayTitle(originalTitle: string, title?: Pick<SemanticSessionTitle, "generatedTitle" | "userTitle">): string {
  return title?.userTitle ?? title?.generatedTitle ?? originalTitle;
}

function turnIdentity(turn: Turn): TurnIdentity {
  return { providerId: turn.providerId, sessionId: turn.sessionId, nativeTurnId: turn.nativeTurnId };
}

function sameGenerator(left: SemanticGeneratorIdentity, right: SemanticGeneratorIdentity): boolean {
  return left.id === right.id && left.version === right.version && left.model === right.model;
}

interface TraceRow {
  readonly provider_id: string;
  readonly session_id: string;
  readonly native_turn_id: string;
  readonly trace_text: string;
  readonly input_fingerprint: string;
  readonly generator_id: string;
  readonly generator_version: string;
  readonly generator_model: string | null;
  readonly generated_at: string;
}

interface FeedbackRow {
  readonly provider_id: string;
  readonly session_id: string;
  readonly native_turn_id: string;
  readonly verdict: SemanticTraceUserVerdict;
  readonly ai_original_text: string;
  readonly edited_text: string | null;
  readonly source_fingerprint: string;
  readonly reviewed_at: string;
}

interface SessionTitleRow {
  readonly provider_id: string;
  readonly session_id: string;
  readonly generated_title: string;
  readonly user_title: string | null;
  readonly generator_id: string;
  readonly generator_version: string;
  readonly generator_model: string | null;
  readonly source_fingerprint: string;
  readonly generated_at: string;
  readonly user_edited_at: string | null;
}

interface SemanticParentRow {
  readonly provider_id: string;
  readonly child_session_id: string;
  readonly generated_parent_session_id: string | null;
  readonly generated_relation: SemanticParentRelation;
  readonly generated_reason: string;
  readonly generator_id: string;
  readonly generator_version: string;
  readonly generator_model: string | null;
  readonly source_fingerprint: string;
  readonly generated_at: string;
  readonly user_parent_session_id: string | null;
  readonly user_relation: SemanticParentRelation | null;
  readonly user_reviewed_at: string | null;
}

function projectRow(row: TraceRow): TurnSemanticTrace {
  return {
    providerId: row.provider_id,
    sessionId: row.session_id,
    nativeTurnId: row.native_turn_id,
    text: row.trace_text,
    inputFingerprint: row.input_fingerprint,
    generator: { id: row.generator_id, version: row.generator_version, model: row.generator_model ?? undefined },
    generatedAt: row.generated_at,
  };
}

function projectFeedbackRow(row: FeedbackRow): SemanticTraceUserFeedback {
  return {
    providerId: row.provider_id,
    sessionId: row.session_id,
    nativeTurnId: row.native_turn_id,
    verdict: row.verdict,
    aiOriginalText: row.ai_original_text,
    editedText: row.edited_text ?? undefined,
    sourceFingerprint: row.source_fingerprint,
    reviewedAt: row.reviewed_at,
  };
}

function projectSessionTitleRow(row: SessionTitleRow): SemanticSessionTitle {
  return {
    providerId: row.provider_id,
    sessionId: row.session_id,
    generatedTitle: row.generated_title,
    userTitle: row.user_title ?? undefined,
    generator: { id: row.generator_id, version: row.generator_version, model: row.generator_model ?? undefined },
    sourceFingerprint: row.source_fingerprint,
    generatedAt: row.generated_at,
    userEditedAt: row.user_edited_at ?? undefined,
  };
}

function projectSemanticParentRow(row: SemanticParentRow): SemanticParentEdge {
  return {
    providerId: row.provider_id,
    childSessionId: row.child_session_id,
    generatedParentSessionId: row.generated_parent_session_id ?? undefined,
    generatedRelation: row.generated_relation,
    generatedReason: row.generated_reason,
    generator: { id: row.generator_id, version: row.generator_version, model: row.generator_model ?? undefined },
    sourceFingerprint: row.source_fingerprint,
    generatedAt: row.generated_at,
    userParentSessionId: row.user_parent_session_id ?? undefined,
    userRelation: row.user_relation ?? undefined,
    userReviewedAt: row.user_reviewed_at ?? undefined,
  };
}
