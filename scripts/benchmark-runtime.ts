import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { NativeLineage, Page, Session, SessionProvider, SessionProviderCapabilities, Turn, WorkspaceScope } from "../packages/core/src/index.ts";
import { materializeSessionForest, projectSessionBranches, type ForestSessionInput } from "../packages/forest/src/index.ts";
import { OrganizationRepository, ProgressiveOrganizationService, type OrganizationExecutionContext, type ProgressiveOrganizationPort } from "../packages/organizer/src/index.ts";
import { WorkspaceSearchIndex } from "../apps/local-web/src/search-index.ts";
import { buildMapGraph } from "../apps/local-web/map-v2/src/graph.ts";
import type { MapForest, TurnDirectoryItem } from "../apps/local-web/map-v2/src/types.ts";

const workspaceId = "benchmark-workspace";
const outputPath = resolve(process.argv[2] ?? "benchmarks/results/runtime.json");

async function run(): Promise<void> {
  const results: Record<string, number> = {};

for (const sessionCount of [50, 100, 500]) {
  const fixture = createFixture(sessionCount, 3);
  results[`forest_${sessionCount}_sessions_ms`] = median(() => materializeSessionForest(workspaceId, fixture.inputs));
  const forest = materializeSessionForest(workspaceId, fixture.inputs);
  results[`graph_${sessionCount}_sessions_ms`] = median(() => buildMapGraph({ forest: forest as unknown as MapForest, expanded: new Set(), turnDirectories: new Map() }));
}

for (const turnCount of [10, 100, 500]) {
  const fixture = createFixture(1, turnCount);
  const forest = materializeSessionForest(workspaceId, fixture.inputs);
  const directory = new Map<string, readonly TurnDirectoryItem[]>([[fixture.sessions[0].providerSessionId, fixture.turns.get(fixture.sessions[0].providerSessionId)!.map(({ nativeTurnId, displayOrdinal, input }) => ({ nativeTurnId, displayOrdinal, displayLabel: input.text ?? "" }))]]);
  results[`turn_directory_${turnCount}_turns_ms`] = median(() => fixture.turns.get(fixture.sessions[0].providerSessionId)!.map(({ nativeTurnId, displayOrdinal, input }) => ({ nativeTurnId, displayOrdinal, displayLabel: input.text ?? "" })));
  results[`expanded_graph_${turnCount}_turns_ms`] = median(() => buildMapGraph({ forest: forest as unknown as MapForest, expanded: new Set([fixture.sessions[0].providerSessionId]), turnDirectories: directory }));
}

for (const sessionCount of [50, 100, 500]) {
  const fixture = createFixture(sessionCount, 3);
  const provider = new FixtureProvider(fixture.sessions, fixture.turns);
  const index = new WorkspaceSearchIndex({ provider });
  const started = performance.now();
  index.start(workspaceId);
  await waitFor(() => index.status(workspaceId).state === "ready");
  results[`search_initial_${sessionCount}_sessions_ms`] = performance.now() - started;
  const reconcileStarted = performance.now();
  index.reconcile();
  await waitFor(() => index.status(workspaceId).state === "indexing");
  await waitFor(() => index.status(workspaceId).state === "ready");
  results[`search_reconcile_${sessionCount}_sessions_ms`] = performance.now() - reconcileStarted;
  await index.close();
}

{
  const fixture = createFixture(100, 3);
  const port = new OrganizerFixturePort(fixture.sessions, fixture.turns);
  const repository = new OrganizationRepository();
  const service = new ProgressiveOrganizationService({ repository, port });
  const started = performance.now();
  const job = await service.start({ workspaceId, mode: "full" });
  await waitFor(() => ["completed", "completed_with_failures"].includes(service.get(job.id)?.status ?? ""));
  const completed = service.get(job.id)!;
  results.organizer_full_100_sessions_ms = performance.now() - started;
  results.organizer_planning_100_sessions_ms = completed.planningMs;
  results.organizer_provider_session_reads = port.sessionReads;
  results.organizer_provider_turn_reads = port.turnReads;
  await service.shutdown();
  repository.close();
}

const artifact = {
  protocol: "v0.2-f-structural-v1",
  kind: "SYNTHETIC_FIXTURE",
  measuredAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.versions.node },
  fixture: { sessionSizes: [50, 100, 500], turnsPerSession: 3, longSessionTurns: [10, 100, 500], samplesPerPureProjection: 5 },
  results,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));
}

function createFixture(sessionCount: number, turnsPerSession: number) {
  const sessions = Array.from({ length: sessionCount }, (_, index) => session(index));
  const turns = new Map(sessions.map((value) => [value.providerSessionId, Array.from({ length: turnsPerSession }, (_, index) => turn(value.providerSessionId, index + 1))]));
  const inputs: ForestSessionInput[] = sessions.map((value, index) => ({
    session: value,
    semanticTitle: { generatedTitle: `Benchmark Session ${index + 1}` },
    semanticParent: index % 10 === 0 ? { generatedRelation: "root" } : { generatedParentSessionId: sessions[index - 1].providerSessionId, generatedRelation: index % 3 === 0 ? "subtask" : "continuation" },
    nativeLineage: null,
    turnCount: turnsPerSession,
    traceCount: 0,
  }));
  const forest = materializeSessionForest(workspaceId, inputs);
  projectSessionBranches(inputs, new Map([...turns].map(([id, values]) => [id, values.map(({ nativeTurnId, displayOrdinal, input }) => ({ nativeTurnId, displayOrdinal, displayLabel: input.text ?? "" }))])));
  return { sessions, turns, inputs, forest };
}

class FixtureProvider implements SessionProvider {
  readonly sessions: readonly Session[];
  readonly turns: ReadonlyMap<string, readonly Turn[]>;
  constructor(sessions: readonly Session[], turns: ReadonlyMap<string, readonly Turn[]>) { this.sessions = sessions; this.turns = turns; }
  async getCapabilities(): Promise<SessionProviderCapabilities> { return { nativeLineage: "none", openSession: false, openTurn: false, liveUpdates: false, titleRead: true, titleWrite: false, archiveRead: true }; }
  async listWorkspaceScopes(): Promise<readonly WorkspaceScope[]> { return [{ id: workspaceId, displayName: "Benchmark", observedRoots: [], source: "cwd", health: { state: "complete", issues: [] } }]; }
  async listSessions(scopeId: string): Promise<Page<Session>> { return { data: scopeId === workspaceId ? this.sessions : [] }; }
  async readSession(sessionId: string): Promise<Session> { const value = this.sessions.find((item) => item.providerSessionId === sessionId); if (!value) throw new Error("missing"); return value; }
  async listTurns(sessionId: string): Promise<Page<Turn>> { return { data: this.turns.get(sessionId) ?? [] }; }
  async getNativeLineage(): Promise<NativeLineage | null> { return null; }
}

class OrganizerFixturePort implements ProgressiveOrganizationPort {
  sessionReads = 0;
  turnReads = 0;
  readonly freshness = new Set<string>();
  readonly sessions: readonly Session[];
  readonly turns: ReadonlyMap<string, readonly Turn[]>;
  constructor(sessions: readonly Session[], turns: ReadonlyMap<string, readonly Turn[]>) { this.sessions = sessions; this.turns = turns; }
  async listSessions() { this.sessionReads += 1; return this.sessions; }
  async listTurns(sessionId: string) { this.turnReads += 1; return this.turns.get(sessionId) ?? []; }
  async inspectTrace(value: Turn) { return state(this.freshness.has(`trace:${value.sessionId}:${value.nativeTurnId}`)); }
  async inspectTitle(value: Session) { return state(this.freshness.has(`title:${value.providerSessionId}`)); }
  async inspectParent(value: Session) { return state(this.freshness.has(`parent:${value.providerSessionId}`)); }
  async generateTrace(value: Turn, context: OrganizationExecutionContext) { this.generated(`trace:${value.sessionId}:${value.nativeTurnId}`, context); }
  async generateTitle(value: Session, context: OrganizationExecutionContext) { this.generated(`title:${value.providerSessionId}`, context); }
  async generateParent(value: Session, context: OrganizationExecutionContext) { this.generated(`parent:${value.providerSessionId}`, context); }
  generated(key: string, context: OrganizationExecutionContext) { context.recordMetrics({ inputChars: 100, modelMs: 0, validationMs: 0, commitMs: 0, retryCount: 0 }); if (context.mayCommit()) this.freshness.add(key); }
}

function state(current: boolean) { return { freshness: current ? "current" as const : "missing" as const, sourceFingerprint: "fixture-source", strategyVersion: "fixture-v1" }; }
function session(index: number): Session { const id = `session-${String(index + 1).padStart(4, "0")}`; return { providerId: "fixture", providerSessionId: id, workspaceScopeId: workspaceId, title: `Session ${index + 1}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), archiveStatus: "active", sourceKind: "interactive", excludedFromMainWorkspaceForest: false, nativeLineageAvailability: "none", health: { state: "complete", issues: [] }, provenance: [] }; }
function turn(sessionId: string, ordinal: number): Turn { return { providerId: "fixture", sessionId, nativeTurnId: `${sessionId}/turn-${ordinal}`, displayOrdinal: ordinal, initiatorKind: "user", status: "completed", input: { text: `Benchmark input ${ordinal} normalization`, attachments: [] }, assistantFinal: `Benchmark result ${ordinal} completed`, tools: [], partial: false, health: { state: "complete", issues: [] }, provenance: [] }; }
function median(operation: () => unknown, samples = 5): number { const values = Array.from({ length: samples }, () => { const started = performance.now(); operation(); return performance.now() - started; }).sort((a, b) => a - b); return values[Math.floor(values.length / 2)]; }
async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> { const started = performance.now(); while (!predicate()) { if (performance.now() - started > timeoutMs) throw new Error("Benchmark timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); } }

await run();
