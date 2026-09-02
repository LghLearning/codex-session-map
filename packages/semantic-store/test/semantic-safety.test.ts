import assert from "node:assert/strict";
import test from "node:test";
import type { Turn } from "../../core/src/index.ts";
import {
  inspectSemanticTraceSafety,
  primaryLanguage,
  PromptTurnSemanticTraceGenerator,
  turnLanguage,
  type SemanticTraceGenerationDiagnostics,
} from "../src/index.ts";

test("guard flags unsupported completion but not legitimate same-Turn completion", () => {
  const planned = turn("计划验证训练与测试归一化是否一致。", "准备运行检查，尚未得到结果。");
  const risk = inspectSemanticTraceSafety(planned, "已验证训练与测试归一化配置不一致。");
  assert.equal(risk.statusUpgradeSuspected, true);
  assert.ok(risk.unsupportedCompletionSignals.includes("validated"));

  const completed = turn("请验证归一化配置。", "已完成验证，确认训练与测试配置一致。");
  assert.equal(inspectSemanticTraceSafety(completed, "已完成验证，训练与测试配置一致。").statusUpgradeSuspected, false);
});

test("guard remains a risk trigger and does not treat suggestions as completed adoption", () => {
  const suggested = turn("请给建议。", "建议考虑采用分层缓存，尚未决定。");
  assert.equal(inspectSemanticTraceSafety(suggested, "建议采用分层缓存，尚未决定。").statusUpgradeSuspected, false);
  assert.equal(inspectSemanticTraceSafety(suggested, "已决定采用分层缓存。").statusUpgradeSuspected, true);
});

test("simple language heuristic follows the user's primary language", () => {
  assert.equal(primaryLanguage("请检查当前实现是否正确 qwen3.5 API"), "zh");
  assert.equal(primaryLanguage("Please inspect the current implementation."), "en");
  assert.equal(inspectSemanticTraceSafety(turn("请检查当前实现。", "尚未检查。"), "Inspection remains pending.").languageMismatch, true);
  assert.equal(turnLanguage(turn("继续", "审计已经完成。")), "zh");
});

test("guard recognizes unprefixed completion wording and explicit completion evidence", () => {
  const futureOnly = turn("计划执行家族整合。", "我会执行家族整合，预计产生 11 个代表。");
  assert.equal(inspectSemanticTraceSafety(futureOnly, "在 D0001 基础上完成家族整合，得到 11 个代表。").statusUpgradeSuspected, true);
  assert.equal(inspectSemanticTraceSafety(futureOnly, "生成 11 个代表并形成 8 个新家族。").statusUpgradeSuspected, true);

  const done = turn("请执行状态检查。", "项目状态检查已经完成，测试通过。");
  assert.equal(inspectSemanticTraceSafety(done, "项目状态检查完成，测试通过。").statusUpgradeSuspected, false);
});

test("prompt generator retries a suspected status upgrade once and clears warning", async () => {
  const values = ["已完成并验证归一化配置。", "计划验证训练与测试归一化配置，尚未执行。"];
  let diagnostics: SemanticTraceGenerationDiagnostics | undefined;
  const generator = new PromptTurnSemanticTraceGenerator({
    client: { model: "fixture", async complete() { return values.shift()!; } },
    promptVersion: "safety-test",
    onDiagnostics: (value) => { diagnostics = value; },
  });
  const result = await generator.generate(turn("计划验证训练与测试归一化。", "准备执行，尚未得到结果。"));
  assert.equal(result.text, "计划验证训练与测试归一化配置，尚未执行。");
  assert.equal(diagnostics?.guardTriggered, true);
  assert.equal(diagnostics?.retried, true);
  assert.equal(diagnostics?.retryFixed, true);
  assert.equal(diagnostics?.semanticSafetyWarning, false);
});

test("prompt generator marks a warning when the single retry remains unsafe", async () => {
  let calls = 0;
  let diagnostics: SemanticTraceGenerationDiagnostics | undefined;
  const generator = new PromptTurnSemanticTraceGenerator({
    client: { model: "fixture", async complete() { calls += 1; return "已确认并完成验证。"; } },
    onDiagnostics: (value) => { diagnostics = value; },
  });
  await generator.generate(turn("计划验证配置。", "尚未执行。"));
  assert.equal(calls, 2);
  assert.equal(diagnostics?.retryFixed, false);
  assert.equal(diagnostics?.semanticSafetyWarning, true);
});

function turn(input: string, assistantFinal: string): Turn {
  return {
    providerId: "fixture",
    sessionId: "session",
    nativeTurnId: "turn",
    displayOrdinal: 1,
    initiatorKind: "user",
    status: "completed",
    input: { text: input, attachments: [] },
    assistantFinal,
    tools: [],
    partial: false,
    health: { state: "complete", issues: [] },
    provenance: [{ providerId: "fixture", tier: "primary", completeness: "complete" }],
  };
}
