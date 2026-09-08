import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { NativeLineage, SemanticTraceLookup, Session, SessionProvider, SessionProviderUpdate, Turn, TurnSemanticTrace } from "../../../packages/core/src/index.ts";
import type { SemanticParentCandidate, SemanticParentEdge, SemanticParentLookup, SemanticParentRelation } from "../../../packages/semantic-store/src/index.ts";
import { UserEditError, normalizeSemanticSessionTitle, normalizeTraceText, type SqliteSemanticTraceStore, type UserField, type UserValue } from "../../../packages/semantic-store/src/index.ts";
import type { SessionForest } from "../../../packages/forest/src/index.ts";
import type { WorkspaceOrganizationProgress, WorkspaceOrganizationResult } from "../../../packages/organizer/src/index.ts";
import { projectTranscriptTurn } from "../../../packages/transcript/src/index.ts";

export interface LocalWebDiagnostics {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly sessionId?: string;
  readonly sourceKey?: string;
  readonly ordinal?: number;
}

export interface LocalWebProvider extends SessionProvider {
  getDiagnostics?(): readonly LocalWebDiagnostics[];
  refresh?(): Promise<void>;
  subscribeUpdates?(listener: (update: SessionProviderUpdate) => void): Promise<() => void>;
}

export interface LocalWebServerOptions {
  readonly provider: LocalWebProvider;
  /** Availability of generation, independently of store-backed reads and edits. */
  readonly semanticGenerationAvailable?: boolean;
  readonly semanticTraces?: LocalWebSemanticTraces;
  readonly semanticTraceUnavailableReason?: string;
  readonly semanticTitles?: LocalWebSemanticTitles;
  readonly semanticTitleUnavailableReason?: string;
  readonly semanticParents?: LocalWebSemanticParents;
  readonly userOverrides?: SqliteSemanticTraceStore;
  readonly forest?: LocalWebForest;
  readonly organizer?: LocalWebOrganizer;
  readonly environment?: LocalWebEnvironment;
  readonly publicDirectory?: string;
  readonly host?: string;
  readonly port?: number;
  readonly pageSize?: number;
}

export interface LocalWebSemanticTraceSafety {
  readonly warning: boolean;
  readonly languageMismatch: boolean;
}

export type LocalWebSemanticTraceVerdict = "accepted" | "edited" | "rejected";

export interface LocalWebSemanticTraceFeedback {
  readonly verdict: LocalWebSemanticTraceVerdict;
  readonly aiOriginalText: string;
  readonly editedText?: string;
  readonly sourceFingerprint: string;
  readonly reviewedAt: string;
}

export interface LocalWebSemanticTraces {
  inspect(turn: Turn): Promise<SemanticTraceLookup>;
  ensure(turn: Turn): Promise<TurnSemanticTrace>;
  regenerate?(turn: Turn): Promise<TurnSemanticTrace>;
  inspectSafety?(turn: Turn, trace: TurnSemanticTrace): LocalWebSemanticTraceSafety;
  getUserFeedback?(turn: Turn): Promise<LocalWebSemanticTraceFeedback | undefined>;
  putUserFeedback?(turn: Turn, feedback: LocalWebSemanticTraceFeedback): Promise<void>;
}

export interface LocalWebSemanticTitleRecord {
  readonly generatedTitle?: string;
  readonly userTitle?: string;
  readonly generator?: { readonly id: string; readonly version: string; readonly model?: string };
  readonly sourceFingerprint?: string;
  readonly generatedAt?: string;
  readonly userEditedAt?: string;
}

export interface LocalWebSemanticTitleLookup {
  readonly freshness: "missing" | "current" | "stale";
  readonly title?: LocalWebSemanticTitleRecord;
  readonly currentSourceFingerprint: string;
}

export interface LocalWebSemanticTitles {
  readStored(session: Session): Promise<LocalWebSemanticTitleRecord | undefined>;
  inspect(session: Session, turns: readonly Turn[]): Promise<LocalWebSemanticTitleLookup>;
  generate(session: Session, turns: readonly Turn[]): Promise<LocalWebSemanticTitleRecord>;
  edit(session: Session, userTitle: string): Promise<LocalWebSemanticTitleRecord>;
}

export interface LocalWebSemanticParentResult {
  readonly lookup: SemanticParentLookup;
  readonly edge?: SemanticParentEdge;
  readonly candidates: readonly SemanticParentCandidate[];
  readonly nativeLineage: NativeLineage | null;
}

export interface LocalWebSemanticParents {
  inspect(session: Session): Promise<LocalWebSemanticParentResult>;
  generate(session: Session): Promise<LocalWebSemanticParentResult>;
  review(session: Session, review: { parentSessionId?: string; anchorTurnId?: string; relation: SemanticParentRelation }): Promise<LocalWebSemanticParentResult>;
}

export interface LocalWebForest {
  materialize(scopeId: string): Promise<SessionForest>;
}

export interface LocalWebOrganizer {
  organize(scopeId: string, options: { signal: AbortSignal; onProgress(progress: WorkspaceOrganizationProgress): void }): Promise<WorkspaceOrganizationResult>;
}

export interface LocalWebEnvironment {
  readonly version: string;
  readonly readOnly: true;
  readonly ollama: { readonly endpoint: string; readonly available: boolean; readonly model: string; readonly thinking: "off"; readonly reason?: string };
  readonly semanticStore: { readonly available: boolean; readonly path: string; readonly schemaVersion: number };
}

interface OrganizationJob {
  readonly id: string;
  readonly scopeId: string;
  readonly controller: AbortController;
  readonly startedAt: string;
  status: "running" | "completed" | "cancelled" | "failed";
  progress: WorkspaceOrganizationProgress;
  result?: WorkspaceOrganizationResult;
  error?: string;
  finishedAt?: string;
}

export interface RunningLocalWebServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const DEFAULT_PUBLIC_DIRECTORY = resolve(import.meta.dirname, "../public");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function createLocalWebServer(options: LocalWebServerOptions): {
  readonly server: Server;
  start(): Promise<RunningLocalWebServer>;
} {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("Local Web must bind to a loopback host.");
  const publicDirectory = options.publicDirectory ?? DEFAULT_PUBLIC_DIRECTORY;
  const pageSize = clamp(options.pageSize ?? 60, 1, 200);
  const eventResponses = new Set<ServerResponse>();
  const organizationJobs = new Map<string, OrganizationJob>();
  const server = createServer(async (request, response) => {
    try {
      if (!isAllowedHost(request.headers.host)) return sendProblem(response, 421, "misdirected_request", "Only loopback Host headers are accepted.");
      setSecurityHeaders(response);
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname.startsWith("/api/")) return await handleApi(options, request, response, url, pageSize, eventResponses, organizationJobs);
      if (request.method !== "GET" && request.method !== "HEAD") return sendProblem(response, 405, "method_not_allowed", "Static assets are read-only.");
      return await serveStatic(publicDirectory, request, response, url.pathname);
    } catch (error) {
      if (error instanceof UserEditError) return sendProblem(response, error.status, "user_edit_error", error.message);
      if (error instanceof TurnNotFoundError) return sendProblem(response, 404, "turn_not_found", error.message);
      return sendProblem(response, 500, "internal_error", safeErrorMessage(error));
    }
  });

  return {
    server,
    async start() {
      await new Promise<void>((resolveStart, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 4319, host, () => {
          server.off("error", reject);
          resolveStart();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local Web did not receive a TCP address.");
      const url = `http://${host}:${address.port}`;
      return {
        host,
        port: address.port,
        url,
        close: () => new Promise<void>((resolveClose, reject) => {
          for (const job of organizationJobs.values()) if (job.status === "running") job.controller.abort();
          for (const eventResponse of eventResponses) eventResponse.end();
          server.close((error) => error ? reject(error) : resolveClose());
        }),
      };
    },
  };
}

async function handleApi(options: LocalWebServerOptions, request: IncomingMessage, response: ServerResponse, url: URL, pageSize: number, eventResponses: Set<ServerResponse>, organizationJobs: Map<string, OrganizationJob>): Promise<void> {
  const provider = options.provider;
  const overrideMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/user-overrides\/(title|label|parent)$/);
  const manualCandidatesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/manual-parents$/);
  const latestEditMatch = url.pathname.match(/^\/api\/scopes\/([^/]+)\/user-edits\/latest$/);
  const undoMatch = url.pathname.match(/^\/api\/user-edits\/([^/]+)\/undo$/);
  if (overrideMatch || manualCandidatesMatch || latestEditMatch || undoMatch) {
    if (!["GET", "HEAD", "POST"].includes(request.method ?? "")) return sendProblem(response, 405, "method_not_allowed", "Unsupported manual edit method.");
    if (request.method === "POST" && !sameOrigin(request)) return sendProblem(response, 403, "cross_origin_denied", "Manual edits require the local UI origin.");
    const store = options.userOverrides;
    if (!store) return sendProblem(response, 503, "user_store_unavailable", "User override storage is unavailable.");
    if (latestEditMatch) {
      if (request.method === "POST") return sendProblem(response, 405, "method_not_allowed", "History reads are read-only.");
      return sendJson(response, 200, { edit: store.overrides.latest(decodePathPart(latestEditMatch[1])) });
    }
    if (undoMatch) {
      if (request.method !== "POST") return sendProblem(response, 405, "method_not_allowed", "Undo requires POST.");
      const body = await readJsonBody(request);
      const edit = store.overrides.history(decodePathPart(undoMatch[1]));
      if (!edit) throw new UserEditError("Manual change not found.", 404);
      const session = await provider.readSession(edit.sessionId);
      if (session.providerId !== edit.providerId) throw new UserEditError("Manual change provider mismatch.");
      const sessions = await loadManualSessions(provider, session.workspaceScopeId);
      return sendJson(response, 200, { edit: store.overrides.undo(edit.id, requireRevision(body.revision), session.workspaceScopeId, sessions) });
    }
    const session = await provider.readSession(decodePathPart((overrideMatch ?? manualCandidatesMatch)![1]));
    if (manualCandidatesMatch) {
      if (request.method === "POST") return sendProblem(response, 405, "method_not_allowed", "Candidate search is read-only.");
      const sessions = await loadManualSessions(provider, session.workspaceScopeId);
      return sendJson(response, 200, { candidates: store.overrides.manualCandidates(session, sessions, url.searchParams.get("q") ?? "") });
    }
    const field = overrideMatch![2] as UserField;
    const nativeTurnId = field === "label" ? url.searchParams.get("turnId") ?? undefined : undefined;
    if (field === "label" && !nativeTurnId) throw new UserEditError("A native Turn ID is required.");
    const turn = nativeTurnId ? await findTurn(provider, session.providerSessionId, nativeTurnId) : undefined;
    const key = { providerId: session.providerId, sessionId: session.providerSessionId, field, nativeTurnId };
    let edit;
    if (request.method === "POST") {
      const body = await readJsonBody(request);
      const value = parseUserValue(field, body.value);
      const sessions = field === "parent" ? await loadManualSessions(provider, session.workspaceScopeId) : undefined;
      if (field === "parent" && value?.anchorTurnId) {
        if (!value.parentSessionId) throw new UserEditError("A Turn anchor requires a parent Session.");
        await validateTurnAnchor(provider, session, value.parentSessionId, value.anchorTurnId);
      }
      edit = store.overrides.write(key, session.workspaceScopeId, value, requireRevision(body.revision), sessions);
    }
    const override = store.overrides.read(key) ?? { ...key, value: null, revision: 0 };
    return sendJson(response, 200, {
      override, edit,
      semanticTitle: field === "title" ? projectSemanticTitle(session.title, await store.getSessionTitle(session.providerId, session.providerSessionId)) : undefined,
      semanticTrace: turn ? await inspectSemanticTrace(turn, options.semanticTraces) : undefined,
      semanticParent: field === "parent" ? projectSemanticParent({
        lookup: { freshness: "missing", currentSourceFingerprint: "", edge: await store.getSemanticParent(session.providerId, session.providerSessionId) },
        candidates: [],
        nativeLineage: await provider.getNativeLineage(session.providerSessionId),
      }) : undefined,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/refresh") {
    if (!sameOrigin(request)) return sendProblem(response, 403, "cross_origin_denied", "Refresh is available only to the local UI origin.");
    if (!provider.refresh) return sendProblem(response, 501, "refresh_unavailable", "This provider does not support snapshot refresh.");
    await provider.refresh();
    return sendJson(response, 200, { refreshedAt: new Date().toISOString() });
  }
  const traceGenerateMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/semantic-trace$/);
  if (request.method === "POST" && traceGenerateMatch) {
    if (!sameOrigin(request)) return sendProblem(response, 403, "cross_origin_denied", "Trace generation is available only to the local UI origin.");
    if (!options.semanticTraces || options.semanticGenerationAvailable === false) return sendProblem(response, 503, "semantic_trace_unavailable", options.semanticTraceUnavailableReason ?? "Local Semantic Trace generation is unavailable.");
    const sessionId = decodePathPart(traceGenerateMatch[1]);
    const turnId = decodePathPart(traceGenerateMatch[2]);
    const turn = await findTurn(provider, sessionId, turnId);
    const force = url.searchParams.get("force") === "1";
    const trace = force && options.semanticTraces.regenerate
      ? await options.semanticTraces.regenerate(turn)
      : await options.semanticTraces.ensure(turn);
    const feedback = await options.semanticTraces.getUserFeedback?.(turn);
    return sendJson(response, 200, { semanticTrace: projectSemanticTrace("current", trace, options.semanticTraces.inspectSafety?.(turn, trace), feedback, trace.inputFingerprint) });
  }
  const traceReviewMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/semantic-trace\/review$/);
  if (request.method === "POST" && traceReviewMatch) {
    if (!sameOrigin(request)) return sendProblem(response, 403, "cross_origin_denied", "Trace feedback is available only to the local UI origin.");
    if (!options.semanticTraces?.putUserFeedback) return sendProblem(response, 503, "semantic_trace_unavailable", "Semantic Trace feedback storage is unavailable.");
    const sessionId = decodePathPart(traceReviewMatch[1]);
    const turnId = decodePathPart(traceReviewMatch[2]);
    const turn = await findTurn(provider, sessionId, turnId);
    const body = await readJsonBody(request);
    const verdict = parseVerdict(body.verdict);
    const lookup = await options.semanticTraces.inspect(turn);
    if (!lookup.trace) return sendProblem(response, 409, "semantic_trace_missing", "Generate a Semantic Trace before reviewing it.");
    const feedback: LocalWebSemanticTraceFeedback = {
      verdict,
      aiOriginalText: lookup.trace.text,
      editedText: verdict === "edited" ? requireEditedText(body.editedText) : undefined,
      sourceFingerprint: lookup.trace.inputFingerprint,
      reviewedAt: new Date().toISOString(),
    };
    await options.semanticTraces.putUserFeedback(turn, feedback);
    return sendJson(response, 200, {
      semanticTrace: projectSemanticTrace(lookup.freshness, lookup.trace, options.semanticTraces.inspectSafety?.(turn, lookup.trace), feedback, lookup.currentInputFingerprint),
    });
  }
  const titleMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/semantic-title$/);
  if ((request.method === "GET" || request.method === "HEAD" || request.method === "POST") && titleMatch) {
    if (!options.semanticTitles) return sendProblem(response, 503, "semantic_title_unavailable", options.semanticTitleUnavailableReason ?? "Local Semantic Session Title generation is unavailable.");
    if (request.method === "POST" && !sameOrigin(request)) return sendProblem(response, 403, "cross_origin_denied", "Semantic Session Title generation is available only to the local UI origin.");
    if (request.method === "POST" && options.semanticGenerationAvailable === false) return sendProblem(response, 503, "semantic_title_unavailable", "Local AI generation is unavailable; stored titles remain readable and editable.");
    const session = await provider.readSession(decodePathPart(titleMatch[1]));
    if (request.method !== "POST") {
      const stored = await options.semanticTitles.readStored(session);
      if (!stored) return sendJson(response, 200, { semanticTitle: projectSemanticTitle(session.title, undefined, "missing") });
    }
    const turns = await loadAllTurns(provider, session.providerSessionId);
    if (request.method === "POST") {
      const title = await options.semanticTitles.generate(session, turns);
      return sendJson(response, 200, { semanticTitle: projectSemanticTitle(session.title, title, "current") });
    }
    const lookup = await options.semanticTitles.inspect(session, turns);
    return sendJson(response, 200, { semanticTitle: projectSemanticTitle(session.title, lookup.title, lookup.freshness) });
  }
  const titleEditMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/semantic-title\/edit$/);
  if (request.method === "POST" && titleEditMatch) {
    if (!sameOrigin(request)) return sendProblem(response, 403, "cross_origin_denied", "Semantic Session Title editing is available only to the local UI origin.");
    if (!options.semanticTitles) return sendProblem(response, 503, "semantic_title_unavailable", "Semantic Session Title storage is unavailable.");
    const session = await provider.readSession(decodePathPart(titleEditMatch[1]));
    const body = await readJsonBody(request);
    const title = await options.semanticTitles.edit(session, requireSemanticTitle(body.title));
    const turns = await loadAllTurns(provider, session.providerSessionId);
    const lookup = await options.semanticTitles.inspect(session, turns);
    return sendJson(response, 200, { semanticTitle: projectSemanticTitle(session.title, title, lookup.freshness) });
  }
  const parentMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/semantic-parent$/);
  if ((request.method === "GET" || request.method === "HEAD" || request.method === "POST") && parentMatch) {
    if (!options.semanticParents) return sendProblem(response, 503, "semantic_parent_unavailable", "Local Semantic Parent inference is unavailable.");
    if (request.method === "POST" && !sameOrigin(request)) return sendProblem(response, 403, "cross_origin_denied", "Semantic Parent inference is available only to the local UI origin.");
    if (request.method === "POST" && options.semanticGenerationAvailable === false) return sendProblem(response, 503, "semantic_parent_unavailable", "Local AI generation is unavailable; stored relationships remain readable and editable.");
    const session = await provider.readSession(decodePathPart(parentMatch[1]));
    const result = request.method === "POST" ? await options.semanticParents.generate(session) : await options.semanticParents.inspect(session);
    return sendJson(response, 200, { semanticParent: projectSemanticParent(result) });
  }
  const parentReviewMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/semantic-parent\/review$/);
  if (request.method === "POST" && parentReviewMatch) {
    if (!sameOrigin(request)) return sendProblem(response, 403, "cross_origin_denied", "Semantic Parent correction is available only to the local UI origin.");
    if (!options.semanticParents) return sendProblem(response, 503, "semantic_parent_unavailable", "Semantic Parent storage is unavailable.");
    const session = await provider.readSession(decodePathPart(parentReviewMatch[1]));
    const body = await readJsonBody(request);
    const relation = parseSemanticParentRelation(body.relation);
    const parentSessionId = typeof body.parentSessionId === "string" && body.parentSessionId.trim() ? body.parentSessionId.trim() : undefined;
    const anchorTurnId = typeof body.anchorTurnId === "string" && body.anchorTurnId.trim() ? body.anchorTurnId.trim() : undefined;
    if (anchorTurnId) {
      if (!parentSessionId) throw new UserEditError("A Turn anchor requires a parent Session.");
      await validateTurnAnchor(provider, session, parentSessionId, anchorTurnId);
    }
    const result = await options.semanticParents.review(session, { relation, parentSessionId, anchorTurnId });
    return sendJson(response, 200, { semanticParent: projectSemanticParent(result) });
  }
  const organizeStartMatch = url.pathname.match(/^\/api\/scopes\/([^/]+)\/organize$/);
  if (request.method === "POST" && organizeStartMatch) {
    if (!sameOrigin(request)) return sendProblem(response, 403, "cross_origin_denied", "Workspace organization is available only to the local UI origin.");
    if (!options.organizer) return sendProblem(response, 503, "organizer_unavailable", "AI generation is unavailable; existing Forest data remains readable.");
    const scopeId = decodePathPart(organizeStartMatch[1]);
    const existing = [...organizationJobs.values()].find((job) => job.scopeId === scopeId && job.status === "running");
    if (existing) return sendJson(response, 202, { job: projectOrganizationJob(existing) });
    const job: OrganizationJob = {
      id: randomUUID(), scopeId, controller: new AbortController(), startedAt: new Date().toISOString(), status: "running",
      progress: { phase: "titles", sessions: 0, titlesProcessed: 0, titlesGenerated: 0, relationshipsProcessed: 0, relationshipsGenerated: 0, warnings: 0 },
    };
    organizationJobs.set(job.id, job);
    void runOrganizationJob(options.organizer, job);
    return sendJson(response, 202, { job: projectOrganizationJob(job) });
  }
  const organizeCancelMatch = url.pathname.match(/^\/api\/organize\/([^/]+)\/cancel$/);
  if (request.method === "POST" && organizeCancelMatch) {
    if (!sameOrigin(request)) return sendProblem(response, 403, "cross_origin_denied", "Workspace organization cancellation is available only to the local UI origin.");
    const job = organizationJobs.get(decodePathPart(organizeCancelMatch[1]));
    if (!job) return sendProblem(response, 404, "organize_job_missing", "Workspace organization job was not found.");
    if (job.status === "running") job.controller.abort();
    return sendJson(response, 202, { job: projectOrganizationJob(job) });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return sendProblem(response, 405, "method_not_allowed", "The local API is read-only.");

  if (url.pathname === "/api/health") return sendJson(response, 200, { ok: true, upstreamPolicy: "read_only" });
  if (url.pathname === "/api/events") {
    if (!provider.subscribeUpdates) return sendProblem(response, 501, "live_updates_unavailable", "This provider does not expose live updates.");
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    eventResponses.add(response);
    response.write("event: ready\ndata: {}\n\n");
    const unsubscribe = await provider.subscribeUpdates((update) => {
      if (!response.destroyed) response.write(`event: snapshot\ndata: ${JSON.stringify(update)}\n\n`);
    });
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(": keep-alive\n\n"); }, 15_000);
    heartbeat.unref();
    request.once("close", () => {
      clearInterval(heartbeat);
      eventResponses.delete(response);
      unsubscribe();
    });
    return;
  }
  if (url.pathname === "/api/bootstrap") {
    const capabilities = await provider.getCapabilities();
    const scopes = await provider.listWorkspaceScopes();
    return sendJson(response, 200, {
      capabilities,
      scopes,
      userOverrides: { available: Boolean(options.userOverrides) },
      semanticTraces: {
        available: Boolean(options.semanticTraces),
        generationAvailable: Boolean(options.semanticTraces) && options.semanticGenerationAvailable !== false,
        mode: "manual_preview",
        reason: options.semanticTraces ? undefined : options.semanticTraceUnavailableReason ?? "Local generator unavailable",
      },
      semanticTitles: {
        available: Boolean(options.semanticTitles),
        generationAvailable: Boolean(options.semanticTitles) && options.semanticGenerationAvailable !== false,
        mode: "manual_current_session",
        reason: options.semanticTitles ? undefined : options.semanticTitleUnavailableReason ?? "Local generator unavailable",
      },
      semanticParents: {
        available: Boolean(options.semanticParents),
        generationAvailable: Boolean(options.semanticParents) && options.semanticGenerationAvailable !== false,
        mode: "manual_current_session",
        relations: ["continuation", "subtask", "root"],
      },
      forest: {
        available: Boolean(options.forest),
        mode: "deterministic_projection",
        openSessionSupported: capabilities.openSession,
        openTurnSupported: capabilities.openTurn,
      },
      organizer: {
        available: Boolean(options.organizer),
        mode: "manual_current_workspace",
      },
      environment: options.environment,
    });
  }
  if (url.pathname === "/api/diagnostics") {
    const diagnostics = provider.getDiagnostics?.() ?? [];
    const scopes = await provider.listWorkspaceScopes();
    const sessionCount = await countProviderSessions(provider, scopes.map((scope) => scope.id));
    return sendJson(response, 200, {
      diagnostics,
      counts: countDiagnostics(diagnostics),
      environment: options.environment,
      source: { status: scopes.length ? "ready" : "no_history", workspaces: scopes.length, sessions: sessionCount },
      capabilities: await provider.getCapabilities(),
    });
  }

  const organizeStatusMatch = url.pathname.match(/^\/api\/organize\/([^/]+)$/);
  if (organizeStatusMatch) {
    const job = organizationJobs.get(decodePathPart(organizeStatusMatch[1]));
    if (!job) return sendProblem(response, 404, "organize_job_missing", "Workspace organization job was not found.");
    return sendJson(response, 200, { job: projectOrganizationJob(job) });
  }

  const scopeMatch = url.pathname.match(/^\/api\/scopes\/([^/]+)\/sessions$/);
  if (scopeMatch) {
    const scopeId = decodePathPart(scopeMatch[1]);
    const includeHidden = url.searchParams.get("includeHidden") === "1";
    const sessions = await loadWindow(
      (cursor) => provider.listSessions(scopeId, cursor),
      url.searchParams.get("cursor") ?? undefined,
      pageSize,
      (session) => includeHidden || !session.excludedFromMainWorkspaceForest,
    );
    return sendJson(response, 200, {
      ...sessions,
      data: await Promise.all(sessions.data.map((session) => projectSessionSummary(session, options.semanticTitles))),
    });
  }

  const forestMatch = url.pathname.match(/^\/api\/scopes\/([^/]+)\/forest$/);
  if (forestMatch) {
    if (!options.forest) return sendProblem(response, 503, "forest_unavailable", "Session Forest projection is unavailable.");
    const forest = await options.forest.materialize(decodePathPart(forestMatch[1]));
    return sendJson(response, 200, { forest });
  }

  const turnDirectoryMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/turn-directory$/);
  if (turnDirectoryMatch) {
    if (request.method !== "GET" && request.method !== "HEAD") return sendProblem(response, 405, "method_not_allowed", "Turn directory access is read-only.");
    const sessionId = decodePathPart(turnDirectoryMatch[1]);
    const turns = await loadWindow(
      (cursor) => provider.listTurns(sessionId, cursor),
      url.searchParams.get("cursor") ?? undefined,
      pageSize,
      () => true,
    );
    return sendJson(response, 200, {
      ...turns,
      data: await Promise.all(turns.data.map(async (turn) => {
        const semantic = await inspectSemanticTrace(turn, options.semanticTraces);
        return { nativeTurnId: turn.nativeTurnId, displayOrdinal: turn.displayOrdinal, displayLabel: semantic.navigationLabel };
      })),
    });
  }

  const turnMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/turns\/([^/]+)$/);
  if (turnMatch) {
    const turn = await findTurn(provider, decodePathPart(turnMatch[1]), decodePathPart(turnMatch[2]));
    return sendJson(response, 200, {
      turn: { ...projectTranscriptTurn(turn), semanticTrace: await inspectSemanticTrace(turn, options.semanticTraces) },
    });
  }

  const turnsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/turns$/);
  if (turnsMatch) {
    const sessionId = decodePathPart(turnsMatch[1]);
    const turns = await loadWindow(
      (cursor) => provider.listTurns(sessionId, cursor),
      url.searchParams.get("cursor") ?? undefined,
      pageSize,
      () => true,
    );
    const data = await Promise.all(turns.data.map(async (turn) => ({
      ...projectTranscriptTurn(turn),
      semanticTrace: await inspectSemanticTrace(turn, options.semanticTraces),
    })));
    return sendJson(response, 200, { ...turns, data });
  }

  const lineageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/lineage$/);
  if (lineageMatch) {
    const lineage = await provider.getNativeLineage(decodePathPart(lineageMatch[1]));
    return sendJson(response, 200, { lineage });
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const session = await provider.readSession(decodePathPart(sessionMatch[1]));
    return sendJson(response, 200, { session: await projectSessionSummary(session, options.semanticTitles) });
  }
  return sendProblem(response, 404, "not_found", "API route not found.");
}

class TurnNotFoundError extends Error {}

async function findTurn(provider: LocalWebProvider, sessionId: string, turnId: string): Promise<Turn> {
  if (provider.readTurn) {
    const turn = await provider.readTurn(sessionId, turnId);
    if (turn) return turn;
    throw new TurnNotFoundError("Unknown session turn");
  }
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await provider.listTurns(sessionId, cursor);
    const turn = page.data.find((candidate) => candidate.nativeTurnId === turnId);
    if (turn) return turn;
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  throw new TurnNotFoundError("Unknown session turn");
}

async function validateTurnAnchor(provider: LocalWebProvider, child: Session, parentSessionId: string, anchorTurnId: string): Promise<void> {
  let anchor: Turn;
  try { anchor = await findTurn(provider, parentSessionId, anchorTurnId); }
  catch (error) {
    if (error instanceof TurnNotFoundError) throw new UserEditError("Turn anchor does not belong to the selected parent Session.");
    throw error;
  }
  const anchorTime = anchor.startedAt ? Date.parse(anchor.startedAt) : Number.NaN;
  const childTime = child.createdAt ? Date.parse(child.createdAt) : Number.NaN;
  if (Number.isFinite(anchorTime) && Number.isFinite(childTime) && anchorTime > childTime) {
    throw new UserEditError("Turn anchor must not occur after the child Session was created.");
  }
}

async function loadAllTurns(provider: LocalWebProvider, sessionId: string): Promise<readonly Turn[]> {
  const turns: Turn[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await provider.listTurns(sessionId, cursor);
    turns.push(...page.data);
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return turns;
}

async function runOrganizationJob(organizer: LocalWebOrganizer, job: OrganizationJob): Promise<void> {
  try {
    const result = await organizer.organize(job.scopeId, {
      signal: job.controller.signal,
      onProgress: (progress) => { job.progress = progress; },
    });
    job.result = result;
    job.progress = result;
    job.status = result.cancelled ? "cancelled" : "completed";
  } catch (error) {
    job.status = job.controller.signal.aborted ? "cancelled" : "failed";
    job.error = safeErrorMessage(error);
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

function projectOrganizationJob(job: OrganizationJob): Readonly<Record<string, unknown>> {
  return {
    id: job.id,
    scopeId: job.scopeId,
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

async function countProviderSessions(provider: LocalWebProvider, scopeIds: readonly string[]): Promise<number> {
  let count = 0;
  for (const scopeId of scopeIds) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await provider.listSessions(scopeId, cursor);
      count += page.data.length;
      if (!page.nextCursor || seen.has(page.nextCursor)) break;
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return count;
}

async function projectSessionSummary(session: Session, semanticTitles: LocalWebSemanticTitles | undefined) {
  const title = await semanticTitles?.readStored(session);
  return {
    ...session,
    originalTitle: session.title,
    displayTitle: title?.userTitle ?? title?.generatedTitle ?? session.title,
    semanticTitle: title ? projectSemanticTitle(session.title, title) : undefined,
  };
}

function projectSemanticTitle(originalTitle: string, title?: LocalWebSemanticTitleRecord, freshness?: "missing" | "current" | "stale") {
  return {
    availability: "available" as const,
    freshness: freshness ?? (title ? undefined : "missing"),
    originalTitle,
    generatedTitle: title?.generatedTitle,
    userTitle: title?.userTitle,
    displayTitle: title?.userTitle ?? title?.generatedTitle ?? originalTitle,
    model: title?.generator?.model,
    promptVersion: title?.generator?.version,
    generatedAt: title?.generatedAt,
    userEditedAt: title?.userEditedAt,
  };
}

function projectSemanticParent(result: LocalWebSemanticParentResult) {
  const edge = result.edge ?? result.lookup.edge;
  const relation = edge?.userRelation ?? edge?.generatedRelation;
  const parentSessionId = edge?.userRelation ? edge.userParentSessionId : edge?.generatedParentSessionId;
  const anchorTurnId = edge?.userRelation ? edge.userAnchorTurnId : undefined;
  return {
    availability: "available" as const,
    freshness: result.lookup.freshness,
    relation,
    parentSessionId,
    anchorTurnId: anchorTurnId ?? null,
    authority: edge?.userRelation ? "user" : edge ? "ai" : undefined,
    generatedRelation: edge?.generatedRelation,
    generatedParentSessionId: edge?.generatedParentSessionId,
    generatedReason: edge?.generatedReason,
    generatedAt: edge?.generatedAt,
    userRelation: edge?.userRelation,
    userParentSessionId: edge?.userParentSessionId,
    userAnchorTurnId: edge?.userAnchorTurnId,
    userReviewedAt: edge?.userReviewedAt,
    model: edge?.generator?.model,
    promptVersion: edge?.generator?.version,
    candidates: result.candidates.map((candidate) => ({
      sessionId: candidate.projection.sessionId,
      title: candidate.projection.semanticTitle ?? candidate.projection.originalTitle,
      originalTitle: candidate.projection.originalTitle,
      createdAt: candidate.projection.createdAt,
      score: Number(candidate.score.toFixed(4)),
      signals: candidate.signals,
    })),
    nativeLineage: result.nativeLineage,
  };
}

async function inspectSemanticTrace(turn: Turn, semanticTraces: LocalWebSemanticTraces | undefined) {
  const fallbackLabel = turn.input?.text?.replace(/\s+/g, " ").trim().slice(0, 120) || `第 ${turn.displayOrdinal} 轮`;
  if (!semanticTraces) return { availability: "unavailable" as const, navigationLabel: fallbackLabel };
  const lookup = await semanticTraces.inspect(turn);
  const feedback = await semanticTraces.getUserFeedback?.(turn);
  const label = feedback?.editedText ?? lookup.trace?.text ?? fallbackLabel;
  if (!lookup.trace) return { availability: "available" as const, freshness: lookup.freshness, displayText: feedback?.editedText, navigationLabel: label, userLabel: feedback?.editedText, userFeedback: feedback };
  return { ...projectSemanticTrace(lookup.freshness, lookup.trace, semanticTraces.inspectSafety?.(turn, lookup.trace), feedback, lookup.currentInputFingerprint), navigationLabel: label, userLabel: feedback?.editedText };
}

function requireRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new UserEditError("A non-negative integer revision is required.");
  return value;
}

function parseUserValue(field: UserField, input: unknown): UserValue | null {
  if (input === null) return null;
  if (!input || typeof input !== "object") throw new UserEditError("An override value or null is required.");
  const value = input as Record<string, unknown>;
  try {
    if (field === "title") return { title: normalizeSemanticSessionTitle(typeof value.title === "string" ? value.title : "") };
    if (field === "label") return { label: normalizeTraceText(typeof value.label === "string" ? value.label : "") };
    if (value.parentSessionId !== undefined && value.parentSessionId !== null && typeof value.parentSessionId !== "string") throw new Error("Parent Session ID must be a string.");
    if (value.anchorTurnId !== undefined && value.anchorTurnId !== null && typeof value.anchorTurnId !== "string") throw new Error("Turn anchor ID must be a string.");
    return {
      relation: parseSemanticParentRelation(value.relation),
      parentSessionId: typeof value.parentSessionId === "string" ? value.parentSessionId : undefined,
      anchorTurnId: typeof value.anchorTurnId === "string" && value.anchorTurnId ? value.anchorTurnId : undefined,
    };
  } catch (error) { throw new UserEditError((error as Error).message); }
}

async function loadManualSessions(provider: LocalWebProvider, workspace: string): Promise<Session[]> {
  const sessions: Session[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await provider.listSessions(workspace, cursor);
    sessions.push(...page.data);
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return sessions;
}

function projectSemanticTrace(
  freshness: SemanticTraceLookup["freshness"],
  trace: TurnSemanticTrace,
  safety?: LocalWebSemanticTraceSafety,
  feedback?: LocalWebSemanticTraceFeedback,
  currentInputFingerprint?: string,
) {
  return {
    availability: "available" as const,
    freshness,
    text: trace.text,
    model: trace.generator.model,
    generatedAt: trace.generatedAt,
    safetyWarning: safety?.warning ?? false,
    languageMismatch: safety?.languageMismatch ?? false,
    aiOriginalText: trace.text,
    reviewedAiOriginalText: feedback?.aiOriginalText,
    displayText: feedback?.editedText ?? trace.text,
    userFeedback: feedback ? {
      verdict: feedback.verdict,
      editedText: feedback.editedText,
      reviewedAt: feedback.reviewedAt,
      basedOnStaleSource: feedback.verdict === "edited" && Boolean(feedback.sourceFingerprint) && feedback.sourceFingerprint !== currentInputFingerprint,
    } : undefined,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 4_096) throw new Error("Request body too large");
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { throw new Error("Malformed JSON request"); }
}

function parseVerdict(value: unknown): LocalWebSemanticTraceVerdict {
  if (value === "accepted" || value === "edited" || value === "rejected") return value;
  throw new Error("Invalid Semantic Trace verdict");
}

function parseSemanticParentRelation(value: unknown): SemanticParentRelation {
  if (value === "continuation" || value === "subtask" || value === "root") return value;
  throw new Error("Semantic Parent relation must be continuation, subtask, or root.");
}

function requireEditedText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Edited Semantic Trace text is required");
  if (value.replace(/\s+/g, " ").trim().length > 240) throw new Error("Edited Semantic Trace must not exceed 240 characters");
  return value;
}

function requireSemanticTitle(value: unknown): string {
  if (typeof value !== "string" || !value.replace(/\s+/g, " ").trim()) throw new Error("Semantic Session Title is required");
  if (value.replace(/\s+/g, " ").trim().length > 80) throw new Error("Semantic Session Title must not exceed 80 characters");
  return value;
}

async function serveStatic(publicDirectory: string, request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  const relative = pathname === "/" || isNavigationPath(pathname) ? "index.html" : pathname.slice(1);
  if (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.includes("..")) return sendProblem(response, 404, "not_found", "Asset not found.");
  const path = resolve(publicDirectory, relative);
  if (!path.startsWith(`${resolve(publicDirectory)}${sep}`)) return sendProblem(response, 404, "not_found", "Asset not found.");
  try {
    const body = await readFile(path);
    response.statusCode = 200;
    response.setHeader("Content-Type", mimeType(path));
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "HEAD") return response.end();
    response.end(body);
  } catch {
    return sendProblem(response, 404, "not_found", "Asset not found.");
  }
}

function isNavigationPath(pathname: string): boolean {
  return pathname === "/workspaces" || pathname.startsWith("/workspaces/");
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
}

function isAllowedHost(value: string | undefined): boolean {
  if (!value) return false;
  const host = value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : value.split(":", 1)[0];
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return LOOPBACK_HOSTS.has(parsed.hostname === "::1" ? "[::1]" : parsed.hostname.toLowerCase()) && parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

function sendProblem(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && /Unknown Codex session|Unknown session|not found/i.test(error.message)) return "The requested session was not found.";
  if (error instanceof Error && /^Semantic Parent generator (returned|selected)/.test(error.message)) return error.message;
  return "The request could not be completed. See local diagnostics for details.";
}

function decodePathPart(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new Error("Malformed path identifier"); }
}

interface WindowCursor {
  readonly providerCursor?: string;
  readonly offset: number;
}

async function loadWindow<T>(
  load: (cursor?: string) => Promise<{ data: readonly T[]; nextCursor?: string }>,
  cursor: string | undefined,
  limit: number,
  include: (value: T) => boolean,
): Promise<{ data: readonly T[]; nextCursor?: string }> {
  const values: T[] = [];
  let position = decodeWindowCursor(cursor);
  const seen = new Set<string>();
  while (values.length < limit) {
    const page = await load(position.providerCursor);
    for (let index = position.offset; index < page.data.length; index += 1) {
      const value = page.data[index];
      if (include(value)) values.push(value);
      if (values.length === limit) {
        const hasMoreInPage = index + 1 < page.data.length;
        return {
          data: values,
          nextCursor: hasMoreInPage
            ? encodeWindowCursor({ providerCursor: position.providerCursor, offset: index + 1 })
            : page.nextCursor ? encodeWindowCursor({ providerCursor: page.nextCursor, offset: 0 }) : undefined,
        };
      }
    }
    if (!page.nextCursor || seen.has(page.nextCursor)) return { data: values };
    seen.add(page.nextCursor);
    position = { providerCursor: page.nextCursor, offset: 0 };
  }
  return { data: values };
}

function encodeWindowCursor(cursor: WindowCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeWindowCursor(cursor: string | undefined): WindowCursor {
  if (!cursor) return { offset: 0 };
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { providerCursor?: unknown; offset?: unknown };
    return {
      providerCursor: typeof value.providerCursor === "string" ? value.providerCursor : undefined,
      offset: Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 ? Number(value.offset) : 0,
    };
  } catch { return { offset: 0 }; }
}

function countDiagnostics(diagnostics: readonly LocalWebDiagnostics[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const diagnostic of diagnostics) counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1;
  return counts;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function mimeType(path: string): string {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}
