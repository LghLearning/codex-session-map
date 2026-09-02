import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CodexAdapterV1 } from "../../../packages/codex-adapter/src/index.ts";
import {
  inspectSemanticTraceSafety,
  assembleSemanticSessionTitleSource,
  LocalOllamaCompletionClient,
  PromptSemanticSessionTitleGenerator,
  PromptSemanticParentGenerator,
  SemanticParentService,
  PromptTurnSemanticTraceGenerator,
  SemanticSessionTitleService,
  SqliteSemanticTraceStore,
  TurnSemanticTraceService,
  buildSemanticSessionProjection,
  DEFAULT_OLLAMA_ENDPOINT,
  DEFAULT_OLLAMA_MODEL,
  preferredSessionDisplayTitle,
  selectSemanticParentCandidates,
  SEMANTIC_STORE_SCHEMA_VERSION,
  type SemanticTraceCompletionClient,
} from "../../../packages/semantic-store/src/index.ts";
import type { Session, Turn } from "../../../packages/core/src/index.ts";
import { materializeSessionForest } from "../../../packages/forest/src/index.ts";
import { organizeWorkspace } from "../../../packages/organizer/src/index.ts";
import { createLocalWebServer, type LocalWebEnvironment, type LocalWebForest, type LocalWebOrganizer, type LocalWebSemanticParents, type LocalWebSemanticTitles, type LocalWebSemanticTraces } from "./server.ts";

const PRODUCT_VERSION = "0.1.0-alpha";
let semanticUnavailableReason: string | undefined;

const args = process.argv.slice(2);
const portArgument = valueAfter(args, "--port");
const port = portArgument ? Number(portArgument) : 4319;
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be an integer from 0 to 65535.");

const adapter = new CodexAdapterV1({
  includeHidden: true,
  disableAppServer: args.includes("--no-app-server"),
  appServerMode: args.includes("--spawn-app-server") ? "spawn" : "proxy",
  appServerExecutable: valueAfter(args, "--codex-bin"),
});
const forestProjection = await createForestProjection(args);
const semantic = await createSemanticPreview(args);
const app = createLocalWebServer({
  provider: adapter,
  port,
  semanticTraces: semantic?.service,
  semanticTitles: semantic?.titles,
  semanticParents: semantic?.parents,
  forest: forestProjection?.forest,
  organizer: semantic?.generationAvailable ? semantic.organizer : undefined,
  semanticGenerationAvailable: semantic?.generationAvailable ?? false,
  environment: environmentStatus(args, semantic, forestProjection),
  semanticTraceUnavailableReason: semantic ? undefined : semanticUnavailableReason ?? "Local Ollama/qwen3.5 is unavailable. The read-only Explorer remains usable.",
  semanticTitleUnavailableReason: semantic ? undefined : semanticUnavailableReason ?? "Local Ollama/qwen3.5 is unavailable. Original Codex titles remain available.",
});
const running = await app.start();

console.log(`Codex Session Map is available at ${running.url}`);
console.log("Upstream access is read-only. Press Ctrl+C to stop.");
console.log(semantic?.generationAvailable ? "Local AI generation is available on demand." : "Local AI generation is unavailable; stored semantic data and transcript browsing remain available when the store is healthy.");

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => {
  await running.close();
  await semantic?.close();
  await forestProjection?.close();
  process.exit(0);
});

async function createSemanticPreview(values: readonly string[]): Promise<{ service: LocalWebSemanticTraces; titles: LocalWebSemanticTitles; parents: LocalWebSemanticParents; organizer: LocalWebOrganizer; generationAvailable: boolean; modelIdentity?: string; close(): Promise<void> } | undefined> {
  try {
    const databasePath = resolve(valueAfter(values, "--semantic-store") ?? ".codex-session-map/semantic-traces.sqlite");
    await mkdir(dirname(databasePath), { recursive: true });
    let runtime: SemanticTraceCompletionClient;
    let generationAvailable = false;
    try {
      if (values.includes("--no-semantic-traces")) throw new Error("Local AI generation was disabled by --no-semantic-traces.");
      runtime = await LocalOllamaCompletionClient.connect({ model: valueAfter(values, "--semantic-model") ?? DEFAULT_OLLAMA_MODEL });
      generationAvailable = true;
    } catch (error) {
      semanticUnavailableReason = error instanceof Error ? error.message : "Local AI is unavailable.";
      console.warn(`AI generation disabled; stored semantic data remains available: ${semanticUnavailableReason}`);
      // This client can never generate. Store reads and user correction do not require Ollama.
      runtime = { model: "unavailable", complete: async () => { throw new Error(semanticUnavailableReason); } };
    }
    const store = new SqliteSemanticTraceStore(databasePath);
    const generator = new PromptTurnSemanticTraceGenerator({ client: runtime, promptVersion: "ollama-qwen3.5-v5-zh-preview" });
    const traceService = new TurnSemanticTraceService({ store, generator });
    const titleGenerator = new PromptSemanticSessionTitleGenerator({ client: runtime, promptVersion: "ollama-qwen3.5-session-title-v3" });
    const titleService = new SemanticSessionTitleService({ store, generator: titleGenerator });
    const parentGenerator = new PromptSemanticParentGenerator({ client: runtime, promptVersion: "ollama-qwen3.5-semantic-parent-v1" });
    const parentService = new SemanticParentService({ store, generator: parentGenerator });
    const titleSource = async (session: Parameters<LocalWebSemanticTitles["inspect"]>[0], turns: Parameters<LocalWebSemanticTitles["inspect"]>[1]) => {
      const traces = await store.listSession(session.providerId, session.providerSessionId);
      const feedback = (await Promise.all(traces.map((trace) => store.getUserFeedback(trace)))).filter((item) => item !== undefined);
      return assembleSemanticSessionTitleSource({ session, turns, traces, feedback });
    };
    const parentContext = async (session: Session) => {
      const sessions = (await listAllSessions(session.workspaceScopeId))
        .filter((candidate) => !candidate.excludedFromMainWorkspaceForest);
      const projections = await Promise.all(sessions.map(async (candidate) => {
        const title = await store.getSessionTitle(candidate.providerId, candidate.providerSessionId);
        const traces = await store.listSession(candidate.providerId, candidate.providerSessionId);
        const feedback = await Promise.all(traces.map((trace) => store.getUserFeedback(trace)));
        const feedbackByTurn = new Map(feedback.filter((item) => item !== undefined).map((item) => [item.nativeTurnId, item]));
        const traceTexts = traces.flatMap((trace) => {
          const review = feedbackByTurn.get(trace.nativeTurnId);
          return review?.verdict === "rejected" ? [] : [review?.editedText ?? trace.text];
        });
        return buildSemanticSessionProjection({
          session: candidate,
          semanticTitle: title ? preferredSessionDisplayTitle(candidate.title, title) : undefined,
          traceTexts,
        });
      }));
      const current = projections.find((projection) => projection.sessionId === session.providerSessionId);
      if (!current) throw new Error("Current Session is unavailable in its Workspace projection.");
      const nativeLineage = await adapter.getNativeLineage(session.providerSessionId);
      const candidates = selectSemanticParentCandidates({ current, sessions: projections, nativeLineage });
      return { source: { current, candidates }, sessions, nativeLineage };
    };
    const listAllSessions = async (scopeId: string): Promise<Session[]> => {
      const sessions: Session[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await adapter.listSessions(scopeId, cursor);
        sessions.push(...page.data);
        if (!page.nextCursor || seen.has(page.nextCursor)) break;
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor);
      return sessions;
    };
    const listAllTurns = async (sessionId: string) => {
      const turns: Turn[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await adapter.listTurns(sessionId, cursor);
        turns.push(...page.data);
        if (!page.nextCursor || seen.has(page.nextCursor)) break;
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor);
      return turns;
    };
    const generateParent = async (session: Session) => {
      const context = await parentContext(session);
      await parentService.generate(context.source, context.sessions);
    };
    return {
      generationAvailable,
      modelIdentity: generationAvailable ? runtime.model : undefined,
      service: {
        inspect: async (turn) => {
          const lookup = await traceService.inspect(turn);
          return !generationAvailable && lookup.trace
            ? { ...lookup, freshness: lookup.trace.inputFingerprint === lookup.currentInputFingerprint ? "current" : "stale" }
            : lookup;
        },
        ensure: (turn) => traceService.ensure(turn),
        regenerate: (turn) => traceService.regenerate(turn),
        inspectSafety: (turn, trace) => {
          const inspection = inspectSemanticTraceSafety(turn, trace.text);
          return { warning: inspection.statusUpgradeSuspected, languageMismatch: inspection.actualLanguage !== "zh" };
        },
        getUserFeedback: async (turn) => {
          const feedback = await store.getUserFeedback(turn);
          return feedback ? {
            verdict: feedback.verdict,
            aiOriginalText: feedback.aiOriginalText,
            editedText: feedback.editedText,
            sourceFingerprint: feedback.sourceFingerprint,
            reviewedAt: feedback.reviewedAt,
          } : undefined;
        },
        putUserFeedback: (turn, feedback) => store.putUserFeedback({
          providerId: turn.providerId,
          sessionId: turn.sessionId,
          nativeTurnId: turn.nativeTurnId,
          ...feedback,
        }),
      },
      titles: {
        readStored: (session) => titleService.readStored(session.providerId, session.providerSessionId),
        inspect: async (session, turns) => {
          const lookup = await titleService.inspect(await titleSource(session, turns));
          return !generationAvailable && lookup.title
            ? { ...lookup, freshness: lookup.title.sourceFingerprint === lookup.currentSourceFingerprint ? "current" : "stale" }
            : lookup;
        },
        generate: async (session, turns) => titleService.generate(await titleSource(session, turns)),
        edit: (session, userTitle) => titleService.edit(session.providerId, session.providerSessionId, userTitle),
      },
      parents: {
        inspect: async (session) => {
          const context = await parentContext(session);
          const lookup = await parentService.inspect(context.source);
          return {
            lookup: !generationAvailable && lookup.edge
              ? { ...lookup, freshness: lookup.edge.sourceFingerprint === lookup.currentSourceFingerprint ? "current" : "stale" }
              : lookup,
            candidates: context.source.candidates, nativeLineage: context.nativeLineage,
          };
        },
        generate: async (session) => {
          const context = await parentContext(session);
          const edge = await parentService.generate(context.source, context.sessions);
          return { lookup: await parentService.inspect(context.source), edge, candidates: context.source.candidates, nativeLineage: context.nativeLineage };
        },
        review: async (session, review) => {
          const context = await parentContext(session);
          const edge = await parentService.review({
            providerId: session.providerId,
            childSessionId: session.providerSessionId,
            parentSessionId: review.parentSessionId,
            relation: review.relation,
            sessions: context.sessions,
          });
          const lookup = await parentService.inspect(context.source);
          return {
            lookup: !generationAvailable && lookup.edge
              ? { ...lookup, freshness: lookup.edge.sourceFingerprint === lookup.currentSourceFingerprint ? "current" : "stale" }
              : lookup,
            edge, candidates: context.source.candidates, nativeLineage: context.nativeLineage,
          };
        },
      },
      organizer: {
        organize: (scopeId, options) => organizeWorkspace({
          scopeId,
          signal: options.signal,
          onProgress: options.onProgress,
          port: {
            listSessions: listAllSessions,
            hasSemanticTitle: async (session) => Boolean(await store.getSessionTitle(session.providerId, session.providerSessionId)),
            generateSemanticTitle: async (session) => {
              const turns = await listAllTurns(session.providerSessionId);
              await titleService.generate(await titleSource(session, turns));
            },
            hasSemanticParent: async (session) => Boolean(await store.getSemanticParent(session.providerId, session.providerSessionId)),
            generateSemanticParent: generateParent,
          },
        }),
      },
      close: () => store.close(),
    };
  } catch (error) {
    semanticUnavailableReason = error instanceof Error ? error.message : "Unknown local runtime error";
    console.warn(`Semantic generation disabled: ${semanticUnavailableReason}`);
    return undefined;
  }
}

async function createForestProjection(values: readonly string[]): Promise<{ forest: LocalWebForest; databasePath: string; close(): Promise<void> } | undefined> {
  try {
    const databasePath = resolve(valueAfter(values, "--semantic-store") ?? ".codex-session-map/semantic-traces.sqlite");
    await mkdir(dirname(databasePath), { recursive: true });
    const store = new SqliteSemanticTraceStore(databasePath);
    const listAllSessions = async (scopeId: string): Promise<Session[]> => {
      const sessions: Session[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await adapter.listSessions(scopeId, cursor);
        sessions.push(...page.data);
        if (!page.nextCursor || seen.has(page.nextCursor)) break;
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor);
      return sessions;
    };
    const countTurns = async (sessionId: string): Promise<number> => {
      let count = 0;
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await adapter.listTurns(sessionId, cursor);
        count += page.data.length;
        if (!page.nextCursor || seen.has(page.nextCursor)) break;
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor);
      return count;
    };
    return {
      forest: {
        materialize: async (scopeId) => {
          const sessions = (await listAllSessions(scopeId)).filter((session) => !session.excludedFromMainWorkspaceForest);
          const inputs = await Promise.all(sessions.map(async (session) => {
            const [semanticTitle, semanticParent, nativeLineage, traces, turnCount] = await Promise.all([
              store.getSessionTitle(session.providerId, session.providerSessionId),
              store.getSemanticParent(session.providerId, session.providerSessionId),
              adapter.getNativeLineage(session.providerSessionId),
              store.listSession(session.providerId, session.providerSessionId),
              countTurns(session.providerSessionId),
            ]);
            return { session, semanticTitle, semanticParent, nativeLineage, turnCount, traceCount: traces.length };
          }));
          return materializeSessionForest(scopeId, inputs);
        },
      },
      databasePath,
      close: () => store.close(),
    };
  } catch (error) {
    console.warn(`Session Forest disabled: ${error instanceof Error ? error.message : "unknown local store error"}`);
    return undefined;
  }
}

function environmentStatus(
  values: readonly string[],
  semantic: Awaited<ReturnType<typeof createSemanticPreview>>,
  forest: Awaited<ReturnType<typeof createForestProjection>>,
): LocalWebEnvironment {
  const requestedModel = valueAfter(values, "--semantic-model") ?? DEFAULT_OLLAMA_MODEL;
  return {
    version: PRODUCT_VERSION,
    readOnly: true,
    ollama: {
      endpoint: DEFAULT_OLLAMA_ENDPOINT,
      available: semantic?.generationAvailable ?? false,
      model: semantic?.modelIdentity ?? requestedModel,
      thinking: "off",
      reason: semantic?.generationAvailable ? undefined : semanticUnavailableReason,
    },
    semanticStore: {
      available: Boolean(forest),
      path: forest?.databasePath ?? resolve(valueAfter(values, "--semantic-store") ?? ".codex-session-map/semantic-traces.sqlite"),
      schemaVersion: SEMANTIC_STORE_SCHEMA_VERSION,
    },
  };
}

function valueAfter(values: readonly string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}
