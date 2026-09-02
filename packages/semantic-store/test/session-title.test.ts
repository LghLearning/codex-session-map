import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Session, Turn, TurnSemanticTrace } from "../../core/src/index.ts";
import {
  assembleSemanticSessionTitleSource,
  buildSemanticSessionTitleRequest,
  semanticSessionContentFingerprint,
  preferredSessionDisplayTitle,
  SemanticSessionTitleService,
  SqliteSemanticTraceStore,
  type SemanticSessionTitleGenerator,
  type SemanticTraceUserFeedback,
} from "../src/index.ts";

test("titles become stale on full-source tail changes even when existing Trace text is unchanged", async () => {
  const turns = [turn(1), turn(2), { ...turn(3), assistantFinal: `${"背景内容。".repeat(200)}\n结论 A` }];
  const traces = turns.map((value) => trace(value, "已有摘要不变。"));
  const before = assembleSemanticSessionTitleSource({ session: session(), turns, traces, feedback: [] });
  const changed = [...turns.slice(0, 2), { ...turns[2], assistantFinal: `${"背景内容。".repeat(200)}\n结论 B` }];
  const after = assembleSemanticSessionTitleSource({ session: session(), turns: changed, traces, feedback: [] });
  assert.equal(buildSemanticSessionTitleRequest(before).input, buildSemanticSessionTitleRequest(after).input, "three existing traces hide the raw change from the sampled prompt");
  assert.notEqual(before.sourceContentFingerprint, after.sourceContentFingerprint);
  assert.equal(semanticSessionContentFingerprint(turns), semanticSessionContentFingerprint(turns.map((value) => ({ ...value, displayOrdinal: value.displayOrdinal + 100 }))));
  const store = new SqliteSemanticTraceStore();
  const service = new SemanticSessionTitleService({ store, generator: generator(["原有标题"]) });
  await service.generate(before);
  const saved = await service.edit(before.providerId, before.sessionId, "用户已有标题");
  assert.equal((await service.inspect(before)).freshness, "current");
  assert.equal((await service.inspect(after)).freshness, "stale");
  assert.deepEqual(await service.readStored(before.providerId, before.sessionId), saved, "stale inspection never rewrites user or AI records");
  await store.close();
});

test("title source follows native Turn order and respects edited/rejected Trace feedback", () => {
  const turns = [turn(1), turn(2), turn(3)];
  const traces = turns.map((value) => trace(value, `AI trace ${value.displayOrdinal}`));
  const feedback: SemanticTraceUserFeedback[] = [
    review(turns[1]!, "edited", "用户修正的第二轮语义。"),
    review(turns[2]!, "rejected"),
  ];
  const source = assembleSemanticSessionTitleSource({ session: session(), turns, traces, feedback });
  assert.equal(source.originalTitle, "Original Codex title");
  assert.equal(source.firstUserInput, "User input 1");
  assert.deepEqual(source.semanticTraces.map((item) => [item.displayOrdinal, item.text]), [
    [1, "AI trace 1"],
    [2, "用户修正的第二轮语义。"],
  ]);
  assert.equal(source.fallbackTurns.length, 3);
});

test("title prompt stays Chinese, bounded, trajectory-aware, and uses fallback only for sparse traces", () => {
  const turns = Array.from({ length: 100 }, (_, index) => turn(index + 1));
  const dense = assembleSemanticSessionTitleSource({ session: session(), turns, traces: turns.map((value) => trace(value, `轨迹 ${value.displayOrdinal}`)), feedback: [] });
  const denseRequest = buildSemanticSessionTitleRequest(dense);
  const denseInput = JSON.parse(denseRequest.input);
  assert.match(denseRequest.system, /完整 Session/);
  assert.match(denseRequest.system, /简体中文/);
  assert.match(denseRequest.system, /不要只改写第一个 Turn/);
  assert.match(denseRequest.system, /不得自行创造或改写版本号/);
  assert.match(denseRequest.system, /C2 时绝不能写成 C2\.0/);
  assert.equal(denseInput.semanticTraceCount, 100);
  assert.equal(denseInput.semanticTraces.length, 64);
  assert.equal(denseInput.semanticTraces[0].turn, 1);
  assert.equal(denseInput.semanticTraces.at(-1).turn, 100);
  assert.deepEqual(denseInput.fallbackPublicTurns, []);

  const sparse = assembleSemanticSessionTitleSource({ session: session(), turns, traces: [trace(turns[0]!, "唯一已有 Trace")], feedback: [] });
  const sparseInput = JSON.parse(buildSemanticSessionTitleRequest(sparse).input);
  assert.equal(sparseInput.semanticTraces.length, 1);
  assert.equal(sparseInput.fallbackPublicTurns.length, 6);
  assert.ok(buildSemanticSessionTitleRequest(sparse).input.length < 12_000);
});

test("generated title persists, becomes stale, and regeneration preserves the user title", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-session-title-"));
  const path = join(root, "semantic.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = sourceWithTrace("完成 Adapter 审计并进入只读 Explorer 验证。");
  const titleGenerator = generator(["Codex 只读 Session Map 审计", "Codex Session Map 产品验证"]);
  const store = new SqliteSemanticTraceStore(path);
  const service = new SemanticSessionTitleService({ store, generator: titleGenerator, now: clock() });

  assert.equal((await service.inspect(source)).freshness, "missing");
  const generated = await service.generate(source);
  assert.equal(generated.generatedTitle, "Codex 只读 Session Map 审计");
  assert.equal((await service.inspect(source)).freshness, "current");
  const edited = await service.edit(source.providerId, source.sessionId, "Codex Session Map 长期导航验证");
  assert.equal(edited.userTitle, "Codex Session Map 长期导航验证");

  const changed = sourceWithTrace("完成 Adapter、Explorer 与 Semantic Trace 的产品验证。");
  assert.equal((await service.inspect(changed)).freshness, "stale");
  const regenerated = await service.generate(changed);
  assert.equal(regenerated.generatedTitle, "Codex Session Map 产品验证");
  assert.equal(regenerated.userTitle, "Codex Session Map 长期导航验证");
  assert.equal(preferredSessionDisplayTitle("Original", regenerated), "Codex Session Map 长期导航验证");
  assert.equal(session().title, "Original Codex title", "the upstream Core Session must remain unchanged");
  await store.close();

  const reopened = new SqliteSemanticTraceStore(path);
  const persisted = await reopened.getSessionTitle(source.providerId, source.sessionId);
  assert.equal(persisted?.generatedTitle, "Codex Session Map 产品验证");
  assert.equal(persisted?.userTitle, "Codex Session Map 长期导航验证");
  assert.equal(preferredSessionDisplayTitle("Original", { generatedTitle: "AI" }), "AI");
  assert.equal(preferredSessionDisplayTitle("Original"), "Original");
  await reopened.close();
});

function session(): Session {
  return {
    providerId: "fixture-provider",
    providerSessionId: "fixture-session",
    workspaceScopeId: "fixture-scope",
    title: "Original Codex title",
    archiveStatus: "active",
    sourceKind: "interactive",
    excludedFromMainWorkspaceForest: false,
    nativeLineageAvailability: "none",
    health: { state: "complete", issues: [] },
    provenance: [{ providerId: "fixture-provider", tier: "primary", completeness: "complete" }],
  };
}

function turn(displayOrdinal: number): Turn {
  return {
    providerId: "fixture-provider",
    sessionId: "fixture-session",
    nativeTurnId: `turn-${displayOrdinal}`,
    displayOrdinal,
    initiatorKind: "user",
    status: "completed",
    input: { text: `User input ${displayOrdinal}`, attachments: [] },
    assistantFinal: `Assistant result ${displayOrdinal}`,
    tools: [],
    partial: false,
    health: { state: "complete", issues: [] },
    provenance: [{ providerId: "fixture-provider", tier: "primary", completeness: "complete" }],
  };
}

function trace(value: Turn, text: string): TurnSemanticTrace {
  return {
    providerId: value.providerId,
    sessionId: value.sessionId,
    nativeTurnId: value.nativeTurnId,
    text,
    inputFingerprint: `fingerprint-${value.displayOrdinal}`,
    generator: { id: "trace", version: "1", model: "fixture" },
    generatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function review(value: Turn, verdict: SemanticTraceUserFeedback["verdict"], editedText?: string): SemanticTraceUserFeedback {
  return {
    providerId: value.providerId,
    sessionId: value.sessionId,
    nativeTurnId: value.nativeTurnId,
    verdict,
    aiOriginalText: `AI trace ${value.displayOrdinal}`,
    editedText,
    sourceFingerprint: `fingerprint-${value.displayOrdinal}`,
    reviewedAt: "2026-09-01T00:00:00.000Z",
  };
}

function sourceWithTrace(text: string) {
  return assembleSemanticSessionTitleSource({ session: session(), turns: [turn(1), turn(2), turn(3)], traces: [trace(turn(1), text), trace(turn(2), "继续验证 Session 浏览体验。"), trace(turn(3), "确认用户反馈可以持久化。")], feedback: [] });
}

function generator(outputs: string[]): SemanticSessionTitleGenerator & { calls: number } {
  return {
    identity: { id: "semantic-session-title", version: "fixture-v1", model: "qwen-fixture" },
    calls: 0,
    async generate() { return { title: outputs[this.calls++] ?? outputs.at(-1)! }; },
  };
}

function clock(): () => Date {
  let minute = 0;
  return () => new Date(`2026-09-01T00:${String(minute++).padStart(2, "0")}:00.000Z`);
}
