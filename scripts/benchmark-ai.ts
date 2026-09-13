import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Turn } from "../packages/core/src/index.ts";
import { LocalOllamaCompletionClient, PromptSemanticParentGenerator, PromptSemanticSessionTitleGenerator, PromptTurnSemanticTraceGenerator, type SemanticGenerationMetrics, type SemanticParentInferenceSource, type SemanticSessionTitleSource } from "../packages/semantic-store/src/index.ts";

const outputPath = resolve(process.argv[2] ?? "benchmarks/results/ai.json");
const client = await LocalOllamaCompletionClient.connect({ model: "qwen3.5" });
const trace = new PromptTurnSemanticTraceGenerator({ client, promptVersion: "ollama-qwen3.5-v5-zh-preview" });
const title = new PromptSemanticSessionTitleGenerator({ client, promptVersion: "ollama-qwen3.5-session-title-v3" });
const parent = new PromptSemanticParentGenerator({ client, promptVersion: "ollama-qwen3.5-semantic-parent-v1" });
const results: Record<string, unknown>[] = [];

await measure("trace", "cold", (onMetrics) => trace.generate(turn("cold"), { onMetrics }));
await measure("trace", "warm", (onMetrics) => trace.generate(turn("warm"), { onMetrics }));
await measure("title", "warm", (onMetrics) => title.generate(titleSource(), { onMetrics }));
await measure("parent", "warm", (onMetrics) => parent.generate(parentSource(), { onMetrics }));

const artifact = {
  protocol: "v0.2-f-ai-v1",
  kind: "REAL_LOCAL_OLLAMA_SYNTHETIC_INPUT",
  measuredAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.versions.node, model: client.model },
  sampleSize: { trace: 2, title: 1, parent: 1 },
  results,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));

async function measure(operation: string, thermalState: string, run: (record: (metrics: SemanticGenerationMetrics) => void) => Promise<unknown>): Promise<void> {
  console.error(`benchmark ${operation} ${thermalState}...`);
  const metrics = { inputChars: 0, modelMs: 0, validationMs: 0, commitMs: 0, retryCount: 0 };
  const started = performance.now();
  let result = "success";
  let errorCode: string | undefined;
  try {
    await run((delta) => { for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[key] += delta[key] ?? 0; });
  } catch (error) {
    result = "failed";
    errorCode = error instanceof Error ? error.name : "unknown";
  }
  results.push({ operation, thermalState, totalMs: performance.now() - started, ...metrics, result, errorCode });
}

function turn(suffix: string): Turn { return { providerId: "fixture", sessionId: "session-current", nativeTurnId: `turn-${suffix}`, displayOrdinal: 1, initiatorKind: "user", status: "completed", input: { text: "检查训练与测试阶段的数据归一化设置是否一致。", attachments: [] }, assistantFinal: "确认两阶段配置不同，已统一配置并通过测试。", tools: [], partial: false, health: { state: "complete", issues: [] }, provenance: [] }; }
function titleSource(): SemanticSessionTitleSource { return { providerId: "fixture", sessionId: "session-current", originalTitle: "数据问题排查", firstUserInput: "检查模型结果异常的原因", semanticTraces: [{ nativeTurnId: "turn-1", displayOrdinal: 1, text: "发现训练与测试归一化配置不一致" }, { nativeTurnId: "turn-2", displayOrdinal: 2, text: "统一配置并完成验证" }], fallbackTurns: [], sourceContentFingerprint: "fixture" }; }
function parentSource(): SemanticParentInferenceSource { return { current: { providerId: "fixture", sessionId: "session-current", workspaceScopeId: "workspace", createdAt: "2026-01-02T00:00:00.000Z", originalTitle: "修复归一化问题", semanticTitle: "统一训练测试归一化配置", representativeTraces: ["发现配置差异", "完成修复验证"] }, candidates: [{ projection: { providerId: "fixture", sessionId: "session-parent", workspaceScopeId: "workspace", createdAt: "2026-01-01T00:00:00.000Z", originalTitle: "模型结果排查", semanticTitle: "排查模型结果异常", representativeTraces: ["开始检查数据处理链路"] }, score: 1, signals: ["title_overlap"] }] }; }
