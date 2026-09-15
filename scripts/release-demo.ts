import type { NativeLineage, Page, SemanticTraceLookup, Session, SessionProviderCapabilities, Turn, TurnSemanticTrace, WorkspaceScope } from "../packages/core/src/index.ts";
import { materializeSessionForest } from "../packages/forest/src/index.ts";
import type { WorkspaceOrganizationProgress } from "../packages/organizer/src/index.ts";
import { createLocalWebServer, type LocalWebSemanticParentResult, type LocalWebSemanticTitleRecord } from "../apps/local-web/src/server.ts";

const scope: WorkspaceScope = {
  id: "demo:product-lab", displayName: "Product Lab", canonicalRoot: "C:\\Projects\\product-lab", observedRoots: ["C:\\Projects\\product-lab"],
  source: "provider_project", health: { state: "complete", issues: [] },
};
const definitions = [
  ["normalization", "Normalize local session history", "Codex history normalization", undefined, "root", "ai"],
  ["trace", "Validate a local trace model", "Local Semantic Trace validation", "normalization", "subtask", "ai"],
  ["titles", "Improve titles", "Stable Semantic Session Titles", "normalization", "continuation", "ai"],
  ["map", "Build a session map", "Codex Session Map local alpha", undefined, "root", "user"],
  ["parents", "Infer relationships", "Semantic Parent inference", "map", "subtask", "ai"],
  ["forest", "Combine the product", "Editable Session Forest MVP", "map", "continuation", "user"],
  ["research", "Review an experiment", "Forecasting experiment audit", undefined, "root", "ai"],
] as const;
const sessions = definitions.map(([id, original], index) => session(id, original, index));
const titleRecords = new Map(definitions.map(([id, , title]) => [id, titleRecord(title)]));
const turns = new Map<string, Turn[]>([["forest", [
  turn("forest", "turn-1", 1, "Materialize a deterministic multi-root forest."),
  turn("forest", "turn-2", 2, "Keep Native Lineage separate from semantic placement."),
  turn("forest", "turn-3", 3, "Add user title and parent correction."),
  turn("forest", "turn-4", 4, "Verify the complete local navigation loop."),
]]]);
const traces = new Map<string, TurnSemanticTrace>(turns.get("forest")!.map((value) => [value.nativeTurnId, trace(value)]));

const provider = {
  async getCapabilities(): Promise<SessionProviderCapabilities> { return { nativeLineage: "partial", openSession: false, openTurn: false, liveUpdates: false, titleRead: true, titleWrite: false, archiveRead: true }; },
  async listWorkspaceScopes() { return [scope]; },
  async listSessions(scopeId: string): Promise<Page<Session>> { return { data: scopeId === scope.id ? sessions : [] }; },
  async readSession(id: string) { const value = sessions.find((item) => item.providerSessionId === id); if (!value) throw new Error("Unknown demo Session"); return value; },
  async listTurns(id: string): Promise<Page<Turn>> { return { data: turns.get(id) ?? [] }; },
  async getNativeLineage(id: string): Promise<NativeLineage | null> { return id === "trace" ? { providerId: "demo", sessionId: id, parentSessionId: "normalization", kind: "user_fork", recovery: "session_only" } : null; },
  getDiagnostics() { return []; },
};

const semanticTitles = {
  async readStored(value: Session) { return titleRecords.get(value.providerSessionId); },
  async inspect(value: Session) { const title = titleRecords.get(value.providerSessionId); return { freshness: title ? "current" as const : "missing" as const, title, currentSourceFingerprint: value.providerSessionId }; },
  async generate(value: Session) { return titleRecords.get(value.providerSessionId)!; },
  async edit(value: Session, userTitle: string) { const record = { ...titleRecords.get(value.providerSessionId)!, userTitle, userEditedAt: new Date().toISOString() }; titleRecords.set(value.providerSessionId, record); return record; },
};
const semanticParents = {
  async inspect(value: Session): Promise<LocalWebSemanticParentResult> {
    const definition = definitions.find(([id]) => id === value.providerSessionId)!;
    const [, , , parentId, relation, source] = definition;
    const edge = {
      providerId: "demo", childSessionId: value.providerSessionId, generatedParentSessionId: parentId, generatedRelation: relation,
      generatedReason: "Sanitized release-demo relationship.", generator: { id: "demo", version: "1", model: "qwen3.5" },
      sourceFingerprint: value.providerSessionId, generatedAt: "2026-09-02T00:00:00.000Z",
      userParentSessionId: source === "user" ? parentId : undefined, userRelation: source === "user" ? relation : undefined,
      userReviewedAt: source === "user" ? "2026-09-02T00:00:00.000Z" : undefined,
    };
    return { lookup: { freshness: "current", edge, currentSourceFingerprint: value.providerSessionId }, edge, candidates: [], nativeLineage: await provider.getNativeLineage(value.providerSessionId) };
  },
  async generate(value: Session) { return this.inspect(value); },
  async review(value: Session) { return this.inspect(value); },
};
const semanticTraces = {
  async inspect(value: Turn): Promise<SemanticTraceLookup> { const stored = traces.get(value.nativeTurnId); return { freshness: stored ? "current" : "missing", trace: stored, currentInputFingerprint: value.nativeTurnId }; },
  async ensure(value: Turn) { return traces.get(value.nativeTurnId)!; },
};
const forest = {
  async materialize(scopeId: string) {
    return materializeSessionForest(scopeId, await Promise.all(sessions.map(async (value) => {
      const definition = definitions.find(([id]) => id === value.providerSessionId)!;
      const [, , , parentId, relation, source] = definition;
      return {
        session: value, semanticTitle: titleRecords.get(value.providerSessionId), nativeLineage: await provider.getNativeLineage(value.providerSessionId),
        semanticParent: {
          generatedParentSessionId: parentId, generatedRelation: relation,
          userParentSessionId: source === "user" ? parentId : undefined, userRelation: source === "user" ? relation : undefined,
        },
        turnCount: turns.get(value.providerSessionId)?.length ?? 6,
        traceCount: traces.size && value.providerSessionId === "forest" ? 4 : 0,
      };
    })));
  },
};
const organizer = {
  async organize(_scopeId: string, options: { onProgress(progress: WorkspaceOrganizationProgress): void }) {
    const result = { phase: "completed" as const, sessions: sessions.length, titlesProcessed: sessions.length, titlesGenerated: 0, relationshipsProcessed: sessions.length, relationshipsGenerated: 0, warnings: 0, cancelled: false, warningDetails: [] };
    options.onProgress(result);
    return result;
  },
};

const running = await createLocalWebServer({
  provider, semanticTitles, semanticParents, semanticTraces, forest, organizer, port: Number(process.argv[2] ?? 4323),
  environment: { version: "0.1.0-alpha", readOnly: true, ollama: { endpoint: "http://127.0.0.1:11434", available: true, model: "qwen3.5", thinking: "off" }, semanticStore: { available: true, path: ".codex-session-map/semantic-traces.sqlite", schemaVersion: 5 } },
}).start();
console.log(`Sanitized release demo: ${running.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => { await running.close(); process.exit(0); });

function session(id: string, title: string, index: number): Session {
  return { providerId: "demo", providerSessionId: id, workspaceScopeId: scope.id, title, createdAt: `2026-08-${String(index + 1).padStart(2, "0")}T09:00:00.000Z`, updatedAt: "2026-09-02T00:00:00.000Z", archiveStatus: "active", sourceKind: "interactive", excludedFromMainWorkspaceForest: false, nativeLineageAvailability: "partial", health: { state: "complete", issues: [] }, provenance: [{ providerId: "demo", tier: "primary", completeness: "complete" }] };
}
function titleRecord(title: string): LocalWebSemanticTitleRecord { return { generatedTitle: title, generator: { id: "demo", version: "1", model: "qwen3.5" }, sourceFingerprint: title, generatedAt: "2026-09-02T00:00:00.000Z" }; }
function turn(sessionId: string, nativeTurnId: string, ordinal: number, text: string): Turn { return { providerId: "demo", sessionId, nativeTurnId, displayOrdinal: ordinal, initiatorKind: "user", status: "completed", input: { text, attachments: [] }, assistantFinal: text, tools: [], partial: false, health: { state: "complete", issues: [] }, provenance: [{ providerId: "demo", tier: "primary", completeness: "complete" }] }; }
function trace(value: Turn): TurnSemanticTrace { return { providerId: "demo", sessionId: value.sessionId, nativeTurnId: value.nativeTurnId, text: value.assistantFinal!, inputFingerprint: value.nativeTurnId, generator: { id: "demo", version: "1", model: "qwen3.5" }, generatedAt: "2026-09-02T00:00:00.000Z" }; }
