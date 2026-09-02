import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Session, Turn } from "../../core/src/index.ts";
import {
  PromptSemanticParentGenerator,
  SemanticParentService,
  SqliteSemanticTraceStore,
  buildSemanticParentRequest,
  buildSemanticSessionProjection,
  parseSemanticParentOutput,
  preferredSemanticParent,
  selectSemanticParentCandidates,
  semanticSessionContentFingerprint,
  type GeneratedSemanticParent,
  type SemanticParentGenerator,
  type SemanticParentInferenceSource,
} from "../src/index.ts";

const sessions = [
  session("parent", "2026-08-01T00:00:00.000Z", "设计 Semantic Trace"),
  session("unrelated", "2026-08-02T00:00:00.000Z", "部署另一个服务"),
  session("child", "2026-08-03T00:00:00.000Z", "继续实现 Semantic Trace UI"),
  session("future", "2026-08-04T00:00:00.000Z", "Semantic Trace 后续"),
];

test("parent freshness follows full current and candidate content without changing inference inputs", async () => {
  const turn: Turn = {
    providerId: "fixture", sessionId: "child", nativeTurnId: "native-1", displayOrdinal: 1,
    initiatorKind: "user", status: "completed", input: { text: "检查", attachments: [] },
    assistantFinal: `${"背景内容。".repeat(200)}\n结论 A`, tools: [], partial: false,
    health: { state: "complete", issues: [] }, provenance: [],
  };
  const before = semanticSessionContentFingerprint([turn]);
  const after = semanticSessionContentFingerprint([{ ...turn, assistantFinal: `${"背景内容。".repeat(200)}\n结论 B` }]);
  const legacySource = sourceFor("child", "parent");
  const source = {
    current: { ...legacySource.current, sourceContentFingerprint: before },
    candidates: legacySource.candidates.map((candidate) => ({ ...candidate, projection: { ...candidate.projection, sourceContentFingerprint: before } })),
  };
  const store = new SqliteSemanticTraceStore();
  const generator = new QueueGenerator([{ relation: "continuation", parentSessionId: "parent", reason: "已有关系" }]);
  const service = new SemanticParentService({ store, generator });
  const saved = await service.generate(source, sessions);
  for (const changed of [
    { ...source, current: { ...source.current, sourceContentFingerprint: after } },
    { ...source, candidates: source.candidates.map((candidate) => ({ ...candidate, projection: { ...candidate.projection, sourceContentFingerprint: after } })) },
  ]) {
    assert.equal(buildSemanticParentRequest(source).input, buildSemanticParentRequest(changed).input);
    assert.equal((await service.inspect(changed)).freshness, "stale");
  }
  assert.equal((await service.inspect(source)).freshness, "current");
  const oldHash = createHash("sha256").update(JSON.stringify({ current: legacySource.current, candidates: legacySource.candidates.map((candidate) => candidate.projection) })).digest("hex");
  await store.putGeneratedSemanticParent({ ...saved, sourceFingerprint: oldHash });
  assert.equal((await service.inspect(legacySource)).freshness, "stale");
  assert.equal((await store.getSemanticParent("fixture", "child"))?.generatedParentSessionId, "parent");
  await store.close();
});

test("candidate selection is same-workspace, past-only, bounded, and keeps the true textual parent", () => {
  const projections = sessions.map((value) => buildSemanticSessionProjection({
    session: value,
    semanticTitle: value.title,
    traceTexts: value.providerSessionId === "parent" ? ["建立 Semantic Trace 数据契约。"] : [],
  }));
  const current = projections.find((value) => value.sessionId === "child")!;
  const candidates = selectSemanticParentCandidates({ current, sessions: projections });
  assert.equal(candidates[0]?.projection.sessionId, "parent");
  assert.equal(candidates.some((value) => value.projection.sessionId === "future"), false);
  assert.ok(candidates.length <= 10);
});

test("structured generator accepts only the relation vocabulary and candidate IDs", async () => {
  const source = sourceFor("child", "parent");
  const requests: unknown[] = [];
  const generator = new PromptSemanticParentGenerator({
    client: {
      model: "qwen3.5",
      async complete(request) {
        requests.push(request);
        return JSON.stringify({ relation: "continuation", parentSessionId: "parent", reason: "继续实现已有语义轨迹工作。" });
      },
    },
  });
  assert.equal((await generator.generate(source)).parentSessionId, "parent");
  assert.equal(parseSemanticParentOutput(`说明：\n{\"relation\":\"root\",\"parentSessionId\":null,\"reason\":\"证据不足。\"}\n完成`, ["parent"]).relation, "root");
  assert.match(buildSemanticParentRequest(source).system, /主题相似.*强行/);
  assert.deepEqual((buildSemanticParentRequest(source).responseJsonSchema as any).properties.parentSessionId.enum, [null, "parent"]);
  assert.equal(requests.length, 1);
  assert.throws(() => parseSemanticParentOutput('{"relation":"related","parentSessionId":"parent","reason":"x"}', ["parent"]), /unsupported/);
  assert.throws(() => parseSemanticParentOutput('{"relation":"subtask","parentSessionId":"outside","reason":"x"}', ["parent"]), /outside/);
});

test("AI edge/root persist, user correction wins display, and regeneration preserves it", async () => {
  const store = new SqliteSemanticTraceStore();
  const generator = new QueueGenerator([
    { relation: "continuation", parentSessionId: "parent", reason: "继续父 Session 的工作。" },
    { relation: "subtask", parentSessionId: "parent", reason: "转为局部实现。" },
  ]);
  const service = new SemanticParentService({ store, generator, now: () => new Date("2026-09-01T00:00:00.000Z") });
  const source = sourceFor("child", "parent");
  const first = await service.generate(source, sessions);
  assert.equal((await store.getSemanticParent("fixture", "child"))?.generatedRelation, "continuation");
  assert.deepEqual(preferredSemanticParent(first), { parentSessionId: "parent", relation: "continuation", authority: "ai" });

  const rooted = await service.review({ providerId: "fixture", childSessionId: "child", relation: "root", sessions });
  assert.deepEqual(preferredSemanticParent(rooted), { parentSessionId: undefined, relation: "root", authority: "user" });
  const regenerated = await service.generate(source, sessions);
  assert.equal(regenerated.generatedRelation, "subtask");
  assert.deepEqual(preferredSemanticParent(regenerated), { parentSessionId: undefined, relation: "root", authority: "user" });
  await store.close();
});

test("user edge rejects future parents and cycles while native lineage remains untouched", async () => {
  const sameTime = [session("a", "2026-08-01T00:00:00.000Z", "A"), session("b", "2026-08-01T00:00:00.000Z", "B")];
  const store = new SqliteSemanticTraceStore();
  const generator = new QueueGenerator([
    { relation: "continuation", parentSessionId: "a", reason: "B follows A." },
    { relation: "root", reason: "A is root." },
  ]);
  const service = new SemanticParentService({ store, generator });
  await service.generate(sourceFor("b", "a", sameTime), sameTime);
  await service.generate(sourceFor("a", undefined, sameTime), sameTime);
  await assert.rejects(
    service.review({ providerId: "fixture", childSessionId: "a", parentSessionId: "b", relation: "continuation", sessions: sameTime }),
    /cycle/,
  );
  await store.putGeneratedSemanticParent({
    providerId: "fixture", childSessionId: "child", generatedRelation: "root", generatedReason: "fixture",
    generator: generator.identity, sourceFingerprint: "fixture", generatedAt: "2026-09-01T00:00:00.000Z",
  });
  await assert.rejects(
    service.review({ providerId: "fixture", childSessionId: "child", parentSessionId: "future", relation: "continuation", sessions }),
    /no later/,
  );
  const native = { providerId: "fixture", sessionId: "child", parentSessionId: "native-parent", kind: "user_fork" as const, recovery: "session_only" as const };
  const before = structuredClone(native);
  selectSemanticParentCandidates({ current: sourceFor("child", "parent").current, sessions: sourceFor("child", "parent").candidates.map((item) => item.projection), nativeLineage: native });
  assert.deepEqual(native, before);
  await store.close();
});

class QueueGenerator implements SemanticParentGenerator {
  readonly identity = { id: "fixture-parent", version: "1", model: "qwen3.5" };
  readonly values: GeneratedSemanticParent[];
  constructor(values: GeneratedSemanticParent[]) { this.values = values; }
  async generate(): Promise<GeneratedSemanticParent> {
    const value = this.values.shift();
    if (!value) throw new Error("No fixture result");
    return value;
  }
}

function sourceFor(childId: string, parentId?: string, values = sessions): SemanticParentInferenceSource {
  const child = values.find((value) => value.providerSessionId === childId)!;
  const parent = parentId ? values.find((value) => value.providerSessionId === parentId)! : undefined;
  return {
    current: buildSemanticSessionProjection({ session: child, semanticTitle: child.title, traceTexts: [] }),
    candidates: parent ? [{ projection: buildSemanticSessionProjection({ session: parent, semanticTitle: parent.title, traceTexts: [] }), score: 1, signals: ["fixture"] }] : [],
  };
}

function session(id: string, createdAt: string, title: string): Session {
  return {
    providerId: "fixture",
    providerSessionId: id,
    workspaceScopeId: "workspace",
    title,
    createdAt,
    archiveStatus: "active",
    sourceKind: "interactive",
    excludedFromMainWorkspaceForest: false,
    nativeLineageAvailability: "none",
    health: { state: "complete", issues: [] },
    provenance: [{ providerId: "fixture", tier: "primary", completeness: "complete" }],
  };
}
