import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Turn } from "../packages/core/src/index.ts";
import { CodexAdapterV1 } from "../packages/codex-adapter/src/index.ts";
import {
  buildSemanticTraceRequestV3,
  LocalOllamaCompletionClient,
  PromptTurnSemanticTraceGenerator,
  semanticInputFingerprint,
  SqliteSemanticTraceStore,
  TurnSemanticTraceService,
  type SemanticTraceCompletionClient,
  type SemanticTraceGenerationDiagnostics,
} from "../packages/semantic-store/src/index.ts";

class CountingClient implements SemanticTraceCompletionClient {
  readonly model: string;
  readonly inner: SemanticTraceCompletionClient;
  calls = 0;
  constructor(inner: SemanticTraceCompletionClient) {
    this.inner = inner;
    this.model = inner.model;
  }
  async complete(request: Parameters<SemanticTraceCompletionClient["complete"]>[0]): Promise<string> { this.calls += 1; return this.inner.complete(request); }
}

const baselinePath = resolve(argument("--baseline", ".codex-session-map/evaluations/qwen3.5-v3/evaluation.json"));
const reviewPath = resolve(argument("--review", ".codex-session-map/evaluations/qwen3.5-v3/human-review.json"));
const outputDirectory = resolve(argument("--output-dir", ".codex-session-map/evaluations/qwen3.5-v4-final"));
const controlledV3StorePath = resolve(argument("--controlled-v3-store", ".codex-session-map/evaluations/qwen3.5-v4/controlled-v3.sqlite"));
const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as BaselineEvaluation;
const oldReview = JSON.parse(await readFile(reviewPath, "utf8")) as BaselineReview;
if (baseline.items.length !== 50) throw new Error(`Safety regression requires the pinned 50-Turn V3 corpus; found ${baseline.items.length}.`);

await mkdir(outputDirectory, { recursive: true });
const adapter = new CodexAdapterV1({ disableAppServer: true, pageSize: 200 });
const turns = await resolvePinnedTurns(adapter, baseline.items);
const runtime = await LocalOllamaCompletionClient.connect({ model: "qwen3.5" });
const v3Client = new CountingClient(runtime);
const v4Client = new CountingClient(runtime);
const v4Diagnostics = new Map<string, SemanticTraceGenerationDiagnostics>();
const v3Generator = new PromptTurnSemanticTraceGenerator({
  client: v3Client,
  promptVersion: "ollama-qwen3.5-v3-controlled",
  requestBuilder: buildSemanticTraceRequestV3,
  safetyGuard: false,
});
const v4Generator = new PromptTurnSemanticTraceGenerator({
  client: v4Client,
  promptVersion: "ollama-qwen3.5-v4.1",
  onDiagnostics: (value) => v4Diagnostics.set(key(value.sessionId, value.nativeTurnId), value),
});
const oldStore = new SqliteSemanticTraceStore(join(dirname(baselinePath), "semantic-traces.sqlite"));
const v3Store = new SqliteSemanticTraceStore(controlledV3StorePath);
const v4Store = new SqliteSemanticTraceStore(join(outputDirectory, "semantic-traces.sqlite"));
const v3Service = new TurnSemanticTraceService({ store: v3Store, generator: v3Generator });
const v4Service = new TurnSemanticTraceService({ store: v4Store, generator: v4Generator });

const items: RegressionItem[] = [];
let failures = 0;
for (const [index, turn] of turns.entries()) {
  const baselineItem = baseline.items[index]!;
  const historical = await oldStore.get(turn);
  const oldVerdict = verdictAt(oldReview, index);
  const v3Start = performance.now();
  let controlledV3: string | undefined;
  let v3DurationMs: number | undefined;
  let v4Trace: string | undefined;
  let v4DurationMs: number | undefined;
  let error: string | undefined;
  try {
    controlledV3 = (await v3Service.ensure(turn)).text;
    v3DurationMs = performance.now() - v3Start;
  } catch (cause) {
    error = `controlled-v3: ${errorName(cause)}`;
  }
  try {
    const v4Start = performance.now();
    v4Trace = (await v4Service.ensure(turn)).text;
    v4DurationMs = performance.now() - v4Start;
  } catch (cause) {
    failures += 1;
    error = `${error ? `${error}; ` : ""}v4: ${errorName(cause)}`;
  }
  const diagnostics = v4Diagnostics.get(key(turn.sessionId, turn.nativeTurnId));
  items.push({
    index,
    reference: baselineItem.reference,
    sessionId: turn.sessionId,
    turnId: turn.nativeTurnId,
    ordinal: turn.displayOrdinal,
    status: turn.status,
    categories: baselineItem.categories,
    inputPreview: preview(turn.input.text),
    assistantPreview: preview(turn.assistantFinal),
    historicalV3Trace: baselineItem.trace,
    historicalV3Verdict: oldVerdict,
    controlledV3Trace: controlledV3,
    v4Trace,
    contentDriftSinceHistoricalV3: historical ? historical.inputFingerprint !== semanticInputFingerprint(turn) : true,
    guardTriggered: diagnostics?.guardTriggered ?? false,
    retried: diagnostics?.retried ?? false,
    retryFixed: diagnostics?.retryFixed ?? false,
    semanticSafetyWarning: diagnostics?.semanticSafetyWarning ?? false,
    languageMismatch: diagnostics?.languageMismatch ?? false,
    v3DurationMs: rounded(v3DurationMs),
    v4DurationMs: rounded(v4DurationMs),
    error,
  });
  process.stdout.write(`regressed ${index + 1}/50\n`);
}

const result = {
  generatedAt: new Date().toISOString(),
  runtime: { endpoint: "http://127.0.0.1:11434", model: runtime.model, thinking: "off", temperature: 0 },
  corpus: {
    source: baselinePath,
    pinnedTurns: items.length,
    missingTurns: 0,
    contentDriftSinceHistoricalV3: items.filter((item) => item.contentDriftSinceHistoricalV3).length,
  },
  calls: { controlledV3: v3Client.calls, v4IncludingRetries: v4Client.calls },
  safety: {
    guardTriggered: items.filter((item) => item.guardTriggered).length,
    retryFixed: items.filter((item) => item.retryFixed).length,
    retryStillUnsafe: items.filter((item) => item.semanticSafetyWarning).length,
    languageMismatch: items.filter((item) => item.languageMismatch).length,
  },
  performance: {
    controlledV3AverageMs: average(items.flatMap((item) => item.v3DurationMs ?? [])),
    v4AverageMs: average(items.flatMap((item) => item.v4DurationMs ?? [])),
    failures,
  },
  items,
};
await writeFile(join(outputDirectory, "regression.json"), JSON.stringify(result, null, 2));
await writeFile(join(outputDirectory, "corpus-manifest.json"), JSON.stringify(baseline.items.map((item, index) => ({ index, sessionId: item.sessionId, turnId: item.turnId })), null, 2));
await writeFile(join(outputDirectory, "review.html"), comparisonHtml(result));
await Promise.all([oldStore.close(), v3Store.close(), v4Store.close()]);
console.log(JSON.stringify({ outputDirectory, corpus: result.corpus, calls: result.calls, safety: result.safety, performance: result.performance }, null, 2));

interface BaselineItem { readonly reference: string; readonly sessionId: string; readonly turnId: string; readonly categories: readonly string[]; readonly trace?: string }
interface BaselineEvaluation { readonly items: readonly BaselineItem[] }
interface BaselineReview { readonly verdicts: { readonly accept: readonly number[]; readonly edit: readonly number[]; readonly reject: readonly number[] } }
interface RegressionItem {
  readonly index: number; readonly reference: string; readonly sessionId: string; readonly turnId: string; readonly ordinal: number;
  readonly status: Turn["status"]; readonly categories: readonly string[]; readonly inputPreview?: string; readonly assistantPreview?: string;
  readonly historicalV3Trace?: string; readonly historicalV3Verdict: string; readonly controlledV3Trace?: string; readonly v4Trace?: string;
  readonly contentDriftSinceHistoricalV3: boolean; readonly guardTriggered: boolean; readonly retried: boolean; readonly retryFixed: boolean;
  readonly semanticSafetyWarning: boolean; readonly languageMismatch: boolean; readonly v3DurationMs?: number; readonly v4DurationMs?: number; readonly error?: string;
}

async function resolvePinnedTurns(adapter: CodexAdapterV1, items: readonly BaselineItem[]): Promise<Turn[]> {
  const bySession = new Map<string, Turn[]>();
  for (const sessionId of new Set(items.map((item) => item.sessionId))) bySession.set(sessionId, await allPages((cursor) => adapter.listTurns(sessionId, cursor)));
  return items.map((item) => {
    const turn = bySession.get(item.sessionId)?.find((candidate) => candidate.nativeTurnId === item.turnId);
    if (!turn) throw new Error(`Pinned V3 Turn is unavailable: ${item.reference}`);
    return turn;
  });
}

function verdictAt(review: BaselineReview, index: number): string {
  if (review.verdicts.accept.includes(index)) return "Accept";
  if (review.verdicts.edit.includes(index)) return "Edit";
  if (review.verdicts.reject.includes(index)) return "Reject";
  return "Unreviewed";
}

function comparisonHtml(result: { items: readonly RegressionItem[] }): string {
  const data = JSON.stringify(result).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Semantic Trace V3 vs V4</title><style>body{font:14px/1.5 system-ui;background:#f4f3ee;margin:0}header{position:sticky;top:0;background:white;padding:14px 24px;border-bottom:1px solid #ccc}main{max-width:1200px;margin:auto}.card{background:white;border:1px solid #d4d1c8;border-radius:9px;margin:16px;padding:16px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.trace,.source{white-space:pre-wrap;padding:10px;border-radius:6px;background:#f6f6f2}.v4{background:#edf7f0}.meta{color:#666}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px}textarea{width:100%;min-height:48px}</style></head><body><header><strong>V3 → V4 Safety Regression</strong> · <span id="counts"></span> <button id="export">Export review</button></header><main id="root"></main><script>const result=${data};const key='csm-qwen35-v4-review';const review=JSON.parse(localStorage.getItem(key)||'{}');const issues=['factual/semantic error','certainty upgrade','hallucinated completion','critical relation loss','language mismatch','over-generic'];function save(){localStorage.setItem(key,JSON.stringify(review));counts.textContent=['Accept','Edit','Reject','Unreviewed'].map(v=>v+': '+result.items.filter(i=>(review[i.index]?.verdict||'Unreviewed')===v).length).join(' · ')}for(const i of result.items){const d=document.createElement('article');d.className='card';d.innerHTML='<div class="meta"></div><div class="grid"><div><h3>Historical V3 · <span class="old"></span></h3><div class="trace oldtrace"></div></div><div><h3>V4</h3><div class="trace v4"></div></div></div><h4>Current public Turn</h4><div class="source"></div><div class="actions verdict"></div><div class="actions issues"></div><textarea placeholder="Notes / proposed edit"></textarea>';d.querySelector('.meta').textContent=i.reference+' · '+i.status+' · guard='+i.guardTriggered+' retryFixed='+i.retryFixed+' warning='+i.semanticSafetyWarning+' drift='+i.contentDriftSinceHistoricalV3;d.querySelector('.old').textContent=i.historicalV3Verdict;d.querySelector('.oldtrace').textContent=i.historicalV3Trace||'—';d.querySelector('.v4').textContent=i.v4Trace||('ERROR: '+i.error);d.querySelector('.source').textContent=(i.inputPreview||'—')+'\n\n'+(i.assistantPreview||'—');for(const v of ['Accept','Edit','Reject']){const l=document.createElement('label');l.innerHTML='<input type="radio" name="v'+i.index+'"> '+v;const c=l.firstChild;c.checked=review[i.index]?.verdict===v;c.onchange=()=>{(review[i.index]??={}).verdict=v;save()};d.querySelector('.verdict').append(l)}issues.forEach((v,n)=>{const l=document.createElement('label');l.innerHTML='<input type="checkbox"> '+v;const c=l.firstChild;c.checked=(review[i.index]?.issues||[]).includes(n);c.onchange=()=>{const r=review[i.index]??={};const s=new Set(r.issues||[]);c.checked?s.add(n):s.delete(n);r.issues=[...s];save()};d.querySelector('.issues').append(l)});const notes=d.querySelector('textarea');notes.value=review[i.index]?.notes||'';notes.oninput=()=>{(review[i.index]??={}).notes=notes.value;save()};root.append(d)}export.onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({review},null,2)],{type:'application/json'}));a.download='qwen3.5-v4-review.json';a.click()};save();</script></body></html>`;
}

function key(sessionId: string, turnId: string): string { return `${sessionId}\u0000${turnId}`; }
function preview(value?: string): string | undefined { return value && value.length > 1_200 ? `${value.slice(0, 600)}\n…[local preview clipped]…\n${value.slice(-600)}` : value; }
function rounded(value?: number): number | undefined { return value === undefined ? undefined : Math.round(value * 10) / 10; }
function average(values: readonly number[]): number | undefined { return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : undefined; }
function argument(name: string, fallback: string): string { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? fallback : fallback; }
function errorName(error: unknown): string { return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"; }
async function allPages<T>(load: (cursor?: string) => Promise<{ data: readonly T[]; nextCursor?: string }>): Promise<T[]> { const values: T[]=[]; let cursor: string|undefined; do { const page=await load(cursor); values.push(...page.data); cursor=page.nextCursor; } while(cursor); return values; }
