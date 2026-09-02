import { createHash } from "node:crypto";
import type {
  NativeLineage,
  LiveSessionProvider,
  Page,
  Session,
  SessionProvider,
  SessionProviderCapabilities,
  SourceProvenance,
  Turn,
  WorkspaceScope,
  SessionProviderUpdate,
} from "../../core/src/index.ts";
import { AppServerSource } from "./app-server-source.ts";
import { DiagnosticCollector, type CodexDiagnostic } from "./diagnostics.ts";
import { detectCodexEnvironment, type CodexEnvironment } from "./environment.ts";
import type { CodexProjectRecord, CodexThreadRecord, CodexTurnRecord, SourceSnapshot } from "./internal.ts";
import { canonicalizeWorkspacePath } from "./path-canonicalizer.ts";
import { RolloutCodexSource } from "./rollout-source.ts";
import { StructuredCodexSource } from "./sqlite-source.ts";
import { CodexUpdateMonitor, type SourceInvalidationReason } from "./update-monitor.ts";

export interface CodexAdapterOptions {
  readonly codexHome?: string;
  readonly appServerExecutable?: string;
  readonly disableAppServer?: boolean;
  readonly includeHidden?: boolean;
  readonly pageSize?: number;
  readonly appServerTimeoutMs?: number;
  /** Proxy attaches to an already-running Desktop app-server and is the read-only default. */
  readonly appServerMode?: "proxy" | "spawn";
  readonly watchDebounceMs?: number;
  readonly reconciliationIntervalMs?: number;
  readonly disableFilesystemWatch?: boolean;
}

interface MaterializedState {
  readonly scopes: readonly WorkspaceScope[];
  readonly sessions: ReadonlyMap<string, Session>;
  readonly records: ReadonlyMap<string, CodexThreadRecord>;
  readonly lineage: ReadonlyMap<string, NativeLineage>;
}

export class CodexAdapterV1 implements SessionProvider, LiveSessionProvider {
  readonly #options: CodexAdapterOptions;
  #diagnostics = new DiagnosticCollector();
  #environment?: CodexEnvironment;
  #state?: MaterializedState;
  #appServer?: AppServerSource;
  #structured?: StructuredCodexSource;
  #rollout?: RolloutCodexSource;
  #loadPromise?: Promise<void>;
  #monitor?: CodexUpdateMonitor;
  #revision = 0;
  readonly #updateListeners = new Set<(update: SessionProviderUpdate) => void>();

  constructor(options: CodexAdapterOptions = {}) {
    this.#options = options;
  }

  async getCapabilities(): Promise<SessionProviderCapabilities> {
    await this.#ensureLoaded();
    return {
      nativeLineage: this.#state!.lineage.size ? "partial" : "none",
      openSession: false,
      openTurn: false,
      liveUpdates: true,
      titleRead: true,
      titleWrite: false,
      archiveRead: true,
    };
  }

  async listWorkspaceScopes(): Promise<readonly WorkspaceScope[]> {
    await this.#ensureLoaded();
    return this.#state!.scopes;
  }

  async listSessions(scopeId: string, cursor?: string): Promise<Page<Session>> {
    await this.#ensureLoaded();
    const filtered = [...this.#state!.sessions.values()]
      .filter((session) => session.workspaceScopeId === scopeId)
      .filter((session) => this.#options.includeHidden || !session.excludedFromMainWorkspaceForest)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.providerSessionId.localeCompare(b.providerSessionId));
    return page(filtered, cursor, this.#options.pageSize ?? 100);
  }

  async readSession(sessionId: string): Promise<Session> {
    await this.#ensureLoaded();
    const session = this.#state!.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Codex session: ${sessionId}`);
    return session;
  }

  async listTurns(sessionId: string, cursor?: string): Promise<Page<Turn>> {
    return page(await this.#readTurns(sessionId), cursor, this.#options.pageSize ?? 100);
  }

  async readTurn(sessionId: string, nativeTurnId: string): Promise<Turn | undefined> {
    return (await this.#readTurns(sessionId)).find((turn) => turn.nativeTurnId === nativeTurnId);
  }

  async #readTurns(sessionId: string): Promise<readonly Turn[]> {
    await this.#ensureLoaded();
    const record = this.#state!.records.get(sessionId);
    if (!record) throw new Error(`Unknown Codex session: ${sessionId}`);
    let turns: readonly CodexTurnRecord[] = [];
    if (this.#appServer) {
      try {
        turns = await this.#appServer.listTurns(sessionId);
      } catch (error) {
        this.#diagnostics.add({ code: "app_server_unavailable", severity: "warning", message: `App-server turn read failed; structured fallback was used (${errorName(error)}).`, sessionId });
      }
    }
    if (!turns.length && this.#structured) turns = await this.#structured.listTurns(sessionId);
    if (!turns.length && this.#rollout) turns = await this.#rollout.listTurns(sessionId, record.rolloutPaths);
    return turns.map(projectTurn);
  }

  async getNativeLineage(sessionId: string): Promise<NativeLineage | null> {
    await this.#ensureLoaded();
    return this.#state!.lineage.get(sessionId) ?? null;
  }

  getDiagnostics(): readonly CodexDiagnostic[] {
    return this.#diagnostics.snapshot();
  }

  async getEnvironment(): Promise<CodexEnvironment> {
    if (!this.#environment) this.#environment = await detectCodexEnvironment(this.#options);
    return this.#environment;
  }

  async refresh(): Promise<void> {
    const previous = {
      state: this.#state,
      appServer: this.#appServer,
      structured: this.#structured,
      rollout: this.#rollout,
      diagnostics: this.#diagnostics,
    };
    this.#state = undefined;
    this.#appServer = undefined;
    this.#structured = undefined;
    this.#rollout = undefined;
    this.#diagnostics = new DiagnosticCollector();
    try {
      await this.#ensureLoaded();
    } catch (error) {
      this.#state = previous.state;
      this.#appServer = previous.appServer;
      this.#structured = previous.structured;
      this.#rollout = previous.rollout;
      this.#diagnostics = previous.diagnostics;
      throw error;
    }
  }

  async subscribeUpdates(listener: (update: SessionProviderUpdate) => void): Promise<() => void> {
    await this.#ensureLoaded();
    this.#updateListeners.add(listener);
    if (!this.#monitor) {
      const environment = await this.getEnvironment();
      this.#monitor = new CodexUpdateMonitor({
        sessionsDirectory: environment.sessionsDirectory,
        archivedSessionsDirectory: environment.archivedSessionsDirectory,
        stateDatabase: environment.stateDatabase,
        historyDatabase: environment.historyDatabase,
        debounceMs: this.#options.watchDebounceMs,
        reconciliationIntervalMs: this.#options.reconciliationIntervalMs,
        disableFilesystemWatch: this.#options.disableFilesystemWatch,
        onInvalidate: (reason) => this.#handleInvalidation(reason),
        onWatchError: (error) => this.#diagnostics.add({ code: "live_update_unavailable", severity: "warning", message: `A local source watcher failed; periodic reconciliation remains active (${error.name}).` }),
      });
      this.#monitor.start();
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#updateListeners.delete(listener);
      if (!this.#updateListeners.size) {
        this.#monitor?.close();
        this.#monitor = undefined;
      }
    };
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#state) return;
    if (this.#loadPromise) return this.#loadPromise;
    this.#loadPromise = this.#load();
    try { await this.#loadPromise; }
    finally { this.#loadPromise = undefined; }
  }

  async #load(): Promise<void> {
    const environment = await this.getEnvironment();
    this.#structured = new StructuredCodexSource({ codexHome: environment.codexHome, diagnostics: this.#diagnostics, stateDatabase: environment.stateDatabase, historyDatabase: environment.historyDatabase });
    this.#rollout = new RolloutCodexSource({ codexHome: environment.codexHome, diagnostics: this.#diagnostics });

    let primary: SourceSnapshot = { threads: [], projects: [] };
    if (!this.#options.disableAppServer && environment.appServerExecutable) {
      this.#appServer = new AppServerSource({ executable: environment.appServerExecutable, codexHome: environment.codexHome, diagnostics: this.#diagnostics, timeoutMs: this.#options.appServerTimeoutMs, mode: this.#options.appServerMode ?? "proxy" });
      try {
        primary = await this.#appServer.list();
      } catch (error) {
        this.#appServer = undefined;
        this.#diagnostics.add({ code: "app_server_unavailable", severity: "warning", message: `App-server enumeration failed; local fallbacks remain active (${errorName(error)}).` });
      }
    } else {
      this.#diagnostics.add({ code: "app_server_unavailable", severity: "info", message: "App-server was disabled; local fallbacks were selected explicitly." });
    }

    const [structured, reconciled] = await Promise.all([this.#structured.list(), this.#rollout.list()]);
    const records = mergeSnapshots([reconciled, structured, primary], this.#diagnostics);
    const projects = mergeProjects([...reconciled.projects, ...structured.projects, ...primary.projects]);
    this.#state = await materialize(records, projects, this.#diagnostics);
  }

  async #handleInvalidation(reason: SourceInvalidationReason): Promise<void> {
    try {
      await this.refresh();
      const update: SessionProviderUpdate = {
        revision: ++this.#revision,
        reason,
        occurredAt: new Date().toISOString(),
      };
      for (const listener of this.#updateListeners) listener(update);
    } catch (error) {
      this.#diagnostics.add({ code: "live_update_unavailable", severity: "warning", message: `Read-only reconciliation failed; the previous UI snapshot remains usable (${errorName(error)}).` });
    }
  }
}

function mergeSnapshots(snapshots: readonly SourceSnapshot[], diagnostics: DiagnosticCollector): Map<string, CodexThreadRecord> {
  const merged = new Map<string, CodexThreadRecord>();
  for (const snapshot of snapshots) for (const incoming of snapshot.threads) {
    const existing = merged.get(incoming.id);
    if (!existing) {
      merged.set(incoming.id, incoming);
      continue;
    }
    if (existing.archived !== undefined && incoming.archived !== undefined && existing.archived !== incoming.archived) diagnostics.add({ code: "source_disagreement", severity: "warning", message: "Sources disagree about archive status; higher-precedence value was selected.", sessionId: incoming.id });
    const observedCwds = unique([...existing.observedCwds, ...incoming.observedCwds]);
    merged.set(incoming.id, {
      ...existing,
      ...defined(incoming),
      observedCwds,
      rolloutPaths: unique([...existing.rolloutPaths, ...incoming.rolloutPaths]),
      partial: existing.partial || incoming.partial,
      nativeLineage: incoming.nativeLineage ?? existing.nativeLineage,
    });
  }
  return merged;
}

async function materialize(records: ReadonlyMap<string, CodexThreadRecord>, projects: ReadonlyMap<string, CodexProjectRecord>, diagnostics: DiagnosticCollector): Promise<MaterializedState> {
  const scopes = new Map<string, WorkspaceScope>();
  const rootOwners: { key: string; project: CodexProjectRecord; canonical: string; original: string }[] = [];
  for (const project of projects.values()) {
    const roots = await Promise.all(project.roots.map(canonicalizeWorkspacePath));
    const canonicalRoot = roots[0]?.canonical;
    const id = `provider-project:${project.id}`;
    scopes.set(id, { id, displayName: project.name, canonicalRoot, observedRoots: project.roots, source: "provider_project", health: { state: roots.some((root) => root.ambiguous) ? "partial" : "complete", issues: roots.filter((root) => root.ambiguous).map(() => "ambiguous_project_root") } });
    for (const root of roots) rootOwners.push({ key: root.comparisonKey, project, canonical: root.canonical, original: root.original });
  }

  const sessions = new Map<string, Session>();
  const lineage = new Map<string, NativeLineage>();
  for (const record of records.values()) {
    const paths = await Promise.all(record.observedCwds.map(canonicalizeWorkspacePath));
    const distinct = unique(paths.map((path) => path.comparisonKey));
    let scopeId: string;
    if (record.projectId && projects.has(record.projectId)) {
      scopeId = `provider-project:${record.projectId}`;
    } else {
      const ownerMatches = rootOwners.filter((owner) => paths.some((path) => isWithin(path.comparisonKey, owner.key)));
      const ownerIds = unique(ownerMatches.map((owner) => owner.project.id));
      if (ownerIds.length === 1) scopeId = `provider-project:${ownerIds[0]}`;
      else if (ownerIds.length > 1 || distinct.length > 1) {
        scopeId = "ambiguous";
        diagnostics.add({ code: "project_ambiguity", severity: "warning", message: "The session maps to multiple workspace roots or changed cwd without an explicit project assignment.", sessionId: record.id });
      } else if (paths[0]) {
        scopeId = `cwd:${stableId(paths[0].comparisonKey)}`;
        if (!scopes.has(scopeId)) scopes.set(scopeId, { id: scopeId, displayName: paths[0].displayName, canonicalRoot: paths[0].canonical, observedRoots: record.observedCwds, source: paths[0].ambiguous ? "ambiguous" : "cwd", health: { state: paths[0].ambiguous ? "partial" : "complete", issues: paths[0].ambiguous ? ["relative_or_empty_cwd"] : [] } });
      } else scopeId = "unscoped";
    }
    if (scopeId === "ambiguous" && !scopes.has(scopeId)) scopes.set(scopeId, { id: scopeId, displayName: "Ambiguous", observedRoots: record.observedCwds, source: "ambiguous", health: { state: "partial", issues: ["multiple_workspace_candidates"] } });
    if (scopeId === "unscoped" && !scopes.has(scopeId)) scopes.set(scopeId, { id: scopeId, displayName: "Unscoped", observedRoots: [], source: "ambiguous", health: { state: "partial", issues: ["missing_workspace_evidence"] } });
    if (record.nativeLineage) lineage.set(record.id, record.nativeLineage);
    const relevantDiagnostics = diagnostics.snapshot().filter((item) => item.sessionId === record.id);
    const issues = unique([...(record.partial ? ["partial_upstream_record"] : []), ...relevantDiagnostics.map((item) => item.code)]);
    const hidden = isHiddenSource(record.source);
    sessions.set(record.id, {
      providerId: "codex",
      providerSessionId: record.id,
      workspaceScopeId: scopeId,
      title: record.title ?? record.preview ?? "Untitled Codex session",
      createdAt: iso(record.createdAtMs),
      updatedAt: iso(record.updatedAtMs),
      archiveStatus: record.archived === true ? "archived" : record.archived === false ? "active" : "unknown",
      sourceKind: hidden ? "agent" : interactiveSource(record.source) ? "interactive" : "unknown",
      excludedFromMainWorkspaceForest: hidden,
      nativeLineageAvailability: record.nativeLineage ? record.nativeLineage.recovery === "exact" ? "full" : "partial" : "none",
      health: { state: relevantDiagnostics.some((item) => item.severity === "error") ? "broken" : issues.length ? "partial" : "complete", issues },
      provenance: provenance(record),
    });
  }
  return { scopes: [...scopes.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)), sessions, records, lineage };
}

function projectTurn(record: CodexTurnRecord): Turn {
  return {
    providerId: "codex",
    sessionId: record.sessionId,
    nativeTurnId: record.turnId,
    displayOrdinal: record.ordinal,
    initiatorKind: record.initiator,
    status: record.status,
    input: { text: record.inputText, attachments: record.attachments },
    assistantFinal: record.assistantFinal,
    tools: record.tools,
    startedAt: iso(record.startedAtMs),
    completedAt: iso(record.completedAtMs),
    partial: record.partial,
    health: { state: record.partial ? "partial" : "complete", issues: record.issues },
    provenance: [{ providerId: "codex", tier: record.sourceTier, recordKey: record.turnId, completeness: record.partial ? "partial" : "complete" }],
  };
}

function provenance(record: CodexThreadRecord): SourceProvenance[] {
  const entries: SourceProvenance[] = [{
    providerId: "codex",
    tier: record.sourceTier,
    recordKey: record.id,
    completeness: record.partial ? "partial" : "complete",
    physicalRecordCount: record.sourceTier === "reconciliation" ? record.physicalSegmentCount : undefined,
  }];
  if (record.physicalSegmentCount && record.sourceTier !== "reconciliation") entries.push({ providerId: "codex", tier: "reconciliation", recordKey: record.id, completeness: record.partial ? "partial" : "complete", physicalRecordCount: record.physicalSegmentCount });
  return entries;
}

function mergeProjects(projects: readonly CodexProjectRecord[]): Map<string, CodexProjectRecord> {
  const result = new Map<string, CodexProjectRecord>();
  for (const project of projects) {
    const existing = result.get(project.id);
    result.set(project.id, existing ? { ...project, roots: unique([...existing.roots, ...project.roots]) } : project);
  }
  return result;
}

function page<T>(values: readonly T[], cursor: string | undefined, limit: number): Page<T> {
  const offset = decodeCursor(cursor);
  const data = values.slice(offset, offset + limit);
  return { data, nextCursor: offset + data.length < values.length ? encodeCursor(offset + data.length) : undefined };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return value !== null && typeof value === "object" && Number.isSafeInteger((value as { offset?: number }).offset) && (value as { offset: number }).offset >= 0 ? (value as { offset: number }).offset : 0;
  } catch {
    return 0;
  }
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function isWithin(value: string, root: string): boolean {
  return value === root || value.startsWith(root.endsWith("\\") || root.endsWith("/") ? root : `${root}${root.includes("\\") ? "\\" : "/"}`);
}

function isHiddenSource(source: string | undefined): boolean {
  return /subagent|guardian|agent_role|compact_agent|review_agent/i.test(source ?? "");
}

function interactiveSource(source: string | undefined): boolean {
  return /cli|vscode|appserver|desktop|unknown|exec/i.test(source ?? "");
}

function iso(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  try { return new Date(value).toISOString(); } catch { return undefined; }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}
