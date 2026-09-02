import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Session, Turn } from "../packages/core/src/index.ts";
import { CodexAdapterV1 } from "../packages/codex-adapter/src/index.ts";
import {
  LocalOllamaCompletionClient,
  PromptTurnSemanticTraceGenerator,
  SqliteSemanticTraceStore,
  TurnSemanticTraceService,
  type SemanticTraceCompletionClient,
} from "../packages/semantic-store/src/index.ts";

class CountingClient implements SemanticTraceCompletionClient {
  readonly model: string;
  readonly inner: SemanticTraceCompletionClient;
  calls = 0;
  constructor(inner: SemanticTraceCompletionClient) { this.inner = inner; this.model = inner.model; }
  async complete(request: Parameters<SemanticTraceCompletionClient["complete"]>[0]): Promise<string> {
    this.calls += 1;
    return this.inner.complete(request);
  }
}

const sampleSize = integerArgument("--sample", 50);
const outputDirectory = resolve(stringArgument("--output-dir", ".codex-session-map/evaluations/qwen3.5-v3"));
await mkdir(outputDirectory, { recursive: true });

const adapter = new CodexAdapterV1({ disableAppServer: true, pageSize: 200 });
const runtime = await LocalOllamaCompletionClient.connect({ model: "qwen3.5" });
const countingClient = new CountingClient(runtime);
const generator = new PromptTurnSemanticTraceGenerator({ client: countingClient, promptVersion: "ollama-qwen3.5-v3" });
const store = new SqliteSemanticTraceStore(join(outputDirectory, "semantic-traces.sqlite"));
const service = new TurnSemanticTraceService({ store, generator });

const candidates = await collectCandidates(adapter, 700, 60);
const selected = selectRepresentative(candidates, sampleSize);
if (selected.length < sampleSize) throw new Error(`Only ${selected.length} representative Turns were available; requested ${sampleSize}.`);

const items: EvaluationItem[] = [];
let failures = 0;
for (const [index, candidate] of selected.entries()) {
  const started = performance.now();
  const before = await service.inspect(candidate.turn);
  try {
    const trace = await service.ensure(candidate.turn);
    items.push(projectItem(candidate, trace.text, performance.now() - started, before.freshness === "current"));
  } catch (error) {
    failures += 1;
    items.push(projectItem(candidate, undefined, performance.now() - started, false, errorName(error)));
  }
  process.stdout.write(`generated ${index + 1}/${selected.length}\n`);
}

const callsAfterGeneration = countingClient.calls;
for (const [index, candidate] of selected.entries()) if (!items[index]?.error) await service.ensure(candidate.turn);
const cacheReusedWithoutCalls = countingClient.calls === callsAfterGeneration;
const first = selected[0];
const staleDetection = first ? (await service.inspect({ ...first.turn, assistantFinal: `${first.turn.assistantFinal ?? ""} [local stale probe]` })).freshness === "stale" : false;
const failurePreservedOldTrace = first ? await verifyFailurePreserves(first.turn, store, runtime.model) : false;

const successfulDurations = items.filter((item) => !item.error && !item.cached).map((item) => item.durationMs);
const result: EvaluationResult = {
  generatedAt: new Date().toISOString(),
  runtime: { endpoint: "http://127.0.0.1:11434", model: runtime.model, thinking: "off", promptVersion: generator.identity.version },
  sample: { requested: sampleSize, selected: selected.length, candidatesScanned: candidates.length },
  performance: {
    failures,
    generatedCalls: callsAfterGeneration,
    averageGenerationMs: average(successfulDurations),
    medianGenerationMs: median(successfulDurations),
    minGenerationMs: successfulDurations.length ? Math.min(...successfulDurations) : undefined,
    maxGenerationMs: successfulDurations.length ? Math.max(...successfulDurations) : undefined,
  },
  cacheValidation: { cacheReusedWithoutCalls, staleDetection, failurePreservedOldTrace },
  items,
};
await writeFile(join(outputDirectory, "evaluation.json"), JSON.stringify(result, null, 2));
await writeFile(join(outputDirectory, "review.html"), reviewHtml(result));
await store.close();
console.log(JSON.stringify({
  outputDirectory,
  sample: result.sample,
  performance: result.performance,
  cacheValidation: result.cacheValidation,
  categoryCounts: countCategories(items),
}, null, 2));

interface Candidate { readonly session: Session; readonly turn: Turn; readonly categories: readonly string[] }
interface EvaluationItem {
  readonly reference: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly status: Turn["status"];
  readonly categories: readonly string[];
  readonly inputPreview?: string;
  readonly assistantPreview?: string;
  readonly toolSummary: string;
  readonly trace?: string;
  readonly durationMs: number;
  readonly cached: boolean;
  readonly error?: string;
}
interface EvaluationResult {
  readonly generatedAt: string;
  readonly runtime: { endpoint: string; model: string; thinking: string; promptVersion: string };
  readonly sample: { requested: number; selected: number; candidatesScanned: number };
  readonly performance: { failures: number; generatedCalls: number; averageGenerationMs?: number; medianGenerationMs?: number; minGenerationMs?: number; maxGenerationMs?: number };
  readonly cacheValidation: { cacheReusedWithoutCalls: boolean; staleDetection: boolean; failurePreservedOldTrace: boolean };
  readonly items: readonly EvaluationItem[];
}

async function collectCandidates(adapter: CodexAdapterV1, candidateLimit: number, sessionLimit: number): Promise<Candidate[]> {
  const scopes = await adapter.listWorkspaceScopes();
  const sessions = (await Promise.all(scopes.map((scope) => allPages((cursor) => adapter.listSessions(scope.id, cursor))))).flat()
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, sessionLimit);
  const candidates: Candidate[] = [];
  for (const session of sessions) {
    const turns = await allPages((cursor) => adapter.listTurns(session.providerSessionId, cursor));
    for (const turn of turns) {
      if (!turn.input.text && !turn.assistantFinal && !turn.tools.length) continue;
      candidates.push({ session, turn, categories: categorize(turn) });
      if (candidates.length >= candidateLimit) return candidates;
    }
  }
  return candidates;
}

function selectRepresentative(candidates: readonly Candidate[], limit: number): Candidate[] {
  const order = ["failed", "interrupted", "uncertainty", "recommendation", "decision", "debug", "experiment", "coding", "tool-heavy", "explicit-result"];
  const selected: Candidate[] = [];
  const keys = new Set<string>();
  const sessionCounts = new Map<string, number>();
  const add = (candidate: Candidate) => {
    const key = `${candidate.turn.sessionId}\u0000${candidate.turn.nativeTurnId}`;
    if (keys.has(key) || (sessionCounts.get(candidate.session.providerSessionId) ?? 0) >= 6) return false;
    keys.add(key);
    sessionCounts.set(candidate.session.providerSessionId, (sessionCounts.get(candidate.session.providerSessionId) ?? 0) + 1);
    selected.push(candidate);
    return true;
  };
  for (const category of order) {
    let count = 0;
    for (const candidate of candidates) {
      if (candidate.categories.includes(category) && add(candidate) && ++count >= 5) break;
    }
  }
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    add(candidate);
  }
  return selected.slice(0, limit);
}

function categorize(turn: Turn): string[] {
  const text = `${turn.input.text ?? ""}\n${turn.assistantFinal ?? ""}`.toLocaleLowerCase();
  const values: string[] = [];
  if (turn.status === "failed") values.push("failed");
  if (turn.status === "interrupted") values.push("interrupted");
  if (/可能|怀疑|尚未|未验证|待验证|初步|maybe|might|possible|suspect|unverified|preliminary/.test(text)) values.push("uncertainty");
  if (/建议|推荐|可以考虑|recommend|suggest|should/.test(text)) values.push("recommendation");
  if (/决定|选择|采用|冻结|decision|decide|selected|adopt/.test(text)) values.push("decision");
  if (/调试|排查|错误|失败|异常|debug|bug|error|failure|exception/.test(text)) values.push("debug");
  if (/实验|训练|测试集|消融|模型性能|experiment|training|evaluation|benchmark|ablation/.test(text)) values.push("experiment");
  if (/代码|实现|修复|测试通过|commit|function|class|typescript|python|代码/.test(text) || turn.tools.some((tool) => /exec|apply_patch|write|test/i.test(tool.name))) values.push("coding");
  if (turn.tools.length >= 20) values.push("tool-heavy");
  if (turn.status === "completed" && Boolean(turn.assistantFinal)) values.push("explicit-result");
  return values.length ? values : ["other"];
}

function projectItem(candidate: Candidate, trace: string | undefined, durationMs: number, cached: boolean, error?: string): EvaluationItem {
  return {
    reference: `${short(candidate.session.providerSessionId)}/T${candidate.turn.displayOrdinal}/${short(candidate.turn.nativeTurnId)}`,
    sessionId: candidate.session.providerSessionId,
    turnId: candidate.turn.nativeTurnId,
    ordinal: candidate.turn.displayOrdinal,
    status: candidate.turn.status,
    categories: candidate.categories,
    inputPreview: preview(candidate.turn.input.text),
    assistantPreview: preview(candidate.turn.assistantFinal),
    toolSummary: candidate.turn.tools.length
      ? `${candidate.turn.tools.length} tools: ${candidate.turn.tools.slice(-8).map((tool) => `${tool.name}:${tool.status}`).join(", ")}`
      : "No tools",
    trace,
    durationMs: Math.round(durationMs * 10) / 10,
    cached,
    error,
  };
}

async function verifyFailurePreserves(turn: Turn, store: SqliteSemanticTraceStore, model: string): Promise<boolean> {
  const before = await store.get(turn);
  const failing = new PromptTurnSemanticTraceGenerator({
    client: { model, async complete() { throw new Error("intentional local validation failure"); } },
    promptVersion: "intentional-failure-probe",
  });
  const service = new TurnSemanticTraceService({ store, generator: failing });
  await service.ensure(turn).catch(() => undefined);
  return JSON.stringify(await store.get(turn)) === JSON.stringify(before);
}

function reviewHtml(result: EvaluationResult): string {
  const data = JSON.stringify(result).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>qwen3.5 Semantic Trace Review</title><style>
body{font:14px/1.5 system-ui;margin:0;background:#f5f4ef;color:#20231f}header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ccc;padding:14px 24px;z-index:2}main{max-width:1100px;margin:auto;padding:20px}.card{background:#fff;border:1px solid #d8d5ca;border-radius:10px;padding:18px;margin:14px 0}.trace{font-size:18px;font-weight:650;color:#173b2b}.source{white-space:pre-wrap;max-height:180px;overflow:auto;background:#f7f7f4;padding:10px;border-radius:6px}.meta{color:#666}.actions{display:flex;gap:14px;flex-wrap:wrap;margin-top:12px}textarea{width:100%;min-height:50px}button{padding:7px 12px}label{cursor:pointer}</style></head><body>
<header><strong>qwen3.5 Semantic Trace Review</strong> · <span id="counts"></span> <button id="export">Export review JSON</button></header><main id="root"></main>
<script>const result=${data};const key='csm-qwen35-review-v1';const review=JSON.parse(localStorage.getItem(key)||'{}');const issues=['A factual/semantic error','B certainty upgrade','C relation loss','D over-generic','E hallucinated result'];
function save(){localStorage.setItem(key,JSON.stringify(review));counts.textContent=['Accept','Edit','Reject','Unreviewed'].map(s=>s+': '+result.items.filter(i=>(review[i.reference]?.verdict||'Unreviewed')===s).length).join(' · ')}
for(const item of result.items){const d=document.createElement('article');d.className='card';d.innerHTML='<div class="meta"></div><div class="trace"></div><h4>Input</h4><div class="source input"></div><h4>Assistant final</h4><div class="source assistant"></div><div class="actions verdicts"></div><div class="actions issue-list"></div><textarea placeholder="Notes / proposed edit"></textarea>';d.querySelector('.meta').textContent=item.reference+' · '+item.status+' · '+item.categories.join(', ')+' · '+item.durationMs+' ms';d.querySelector('.trace').textContent=item.trace||('ERROR: '+item.error);d.querySelector('.input').textContent=item.inputPreview||'—';d.querySelector('.assistant').textContent=item.assistantPreview||'—';for(const v of ['Accept','Edit','Reject']){const l=document.createElement('label');l.innerHTML='<input type="radio" name="'+item.reference+'" value="'+v+'"> '+v;const input=l.firstChild;input.checked=review[item.reference]?.verdict===v;input.onchange=()=>{(review[item.reference]??={}).verdict=v;save()};d.querySelector('.verdicts').append(l)}issues.forEach((issue,index)=>{const l=document.createElement('label');l.innerHTML='<input type="checkbox"> '+issue;const input=l.firstChild;input.checked=(review[item.reference]?.issues||[]).includes(index);input.onchange=()=>{const r=review[item.reference]??={};const s=new Set(r.issues||[]);input.checked?s.add(index):s.delete(index);r.issues=[...s];save()};d.querySelector('.issue-list').append(l)});const notes=d.querySelector('textarea');notes.value=review[item.reference]?.notes||'';notes.oninput=()=>{(review[item.reference]??={}).notes=notes.value;save()};root.append(d)}
export.onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({metadata:result,review},null,2)],{type:'application/json'}));a.download='qwen3.5-review.json';a.click()};save();</script></body></html>`;
}

function preview(value?: string): string | undefined { return value && value.length > 1_200 ? `${value.slice(0, 600)}\n…[local preview clipped]…\n${value.slice(-600)}` : value; }
function short(value: string): string { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function average(values: readonly number[]): number | undefined { return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : undefined; }
function median(values: readonly number[]): number | undefined { if (!values.length) return undefined; const sorted = [...values].sort((a,b)=>a-b); return Math.round(sorted[Math.floor(sorted.length / 2)]! * 10) / 10; }
function countCategories(items: readonly EvaluationItem[]): Record<string, number> { const result: Record<string, number> = {}; for (const item of items) for (const category of item.categories) result[category] = (result[category] ?? 0) + 1; return result; }
function errorName(error: unknown): string { return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"; }
function integerArgument(name: string, fallback: number): number { const index = process.argv.indexOf(name); return index >= 0 ? Number.parseInt(process.argv[index + 1] ?? "", 10) : fallback; }
function stringArgument(name: string, fallback: string): string { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? fallback : fallback; }
async function allPages<T>(load: (cursor?: string) => Promise<{ data: readonly T[]; nextCursor?: string }>): Promise<T[]> { const values: T[]=[]; let cursor: string|undefined; do { const page=await load(cursor); values.push(...page.data); cursor=page.nextCursor; } while(cursor); return values; }
