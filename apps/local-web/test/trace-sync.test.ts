import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

// Run the real UI handlers with a small DOM double and controlled API responses.
class Element {
  className = "";
  dataset: Record<string, string> = {};
  style = {};
  value = "";
  scrollTop = 0;
  disabled = false;
  textContent = "";
  children: Element[] = [];
  parent?: Element;
  classList = { add() {}, remove() {}, toggle() {} };
  addEventListener() {}
  setAttribute() {}
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  replaceWith(next: Element) {
    const parent = this.parent!;
    parent.children[parent.children.indexOf(this)] = next;
    next.parent = parent;
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.className.split(" ").includes(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
}

const source = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/^initialize\(\);/m, "");
const missing = { freshness: "missing" };
const trace = (displayText: string) => ({ freshness: "current", displayText, text: displayText });
const turn = (id: string, ordinal: number, semanticTrace = missing) => ({ id, ordinal, sessionId: "s", semanticTrace });

function harness(request: (path: string, options?: RequestInit) => unknown) {
  const nodes = new Map<string, Element>();
  const context = createContext({
    document: {
      getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
      createElement() { return new Element(); },
    },
    window: { addEventListener() {} },
    fetch: async (path: string, options?: RequestInit) => ({ ok: true, json: async () => request(path, options) }),
  });
  runInContext(source, context);
  runInContext(`
    renderTranscript = () => { elements["turn-list"].scrollTop = 0; };
    showToast = () => {};
    navigate = () => { throw new Error("Trace generation must not reload navigation"); };
  `, context);
  const ui = runInContext(`({ state, renderForest, toggleForestTraces, generateSessionTraces, generateSemanticTrace })`, context);
  ui.state.sessionView = "forest";
  ui.state.selectedSession = { providerSessionId: "s" };
  ui.state.semanticTraces = { generationAvailable: true };
  ui.state.forest = {
    stats: { sessions: 1, confirmedRoots: 1, semanticEdges: 0, unorganized: 0, missingTitles: 0 },
    roots: [{ sessionId: "s", turnCount: 3, traceCount: 0, displayTitle: "Session", semanticRelation: "root", placementSource: "AI", children: [] }],
    unorganized: [],
  };
  nodes.get("turn-list")!.scrollTop = 240;
  return { ...ui, nodes };
}

test("batch generation updates Forest and transcript progressively without reloading; reused and failed Turns remain correct", async () => {
  const calls: string[] = [];
  let ui: ReturnType<typeof harness>;
  ui = harness((path, options) => {
    calls.push(path);
    if (options?.method !== "POST") return path.includes("cursor=")
      ? { data: [turn("3", 3)] }
      : { data: [turn("1", 1), turn("2", 2, trace("Already generated"))], nextCursor: "page-2" };
    if (path.includes("/1/")) return { semanticTrace: trace("New trace") };
    assert.equal(ui.state.turns[0].semanticTrace.displayText, "New trace");
    const card = ui.nodes.get("forest-canvas")!.querySelector(".forest-node")!;
    assert.equal(card.querySelector(".forest-turn-count")!.textContent, "3 Turns · 2 Traces");
    assert.equal(card.querySelectorAll(".forest-trace-item").length, 3);
    assert.equal(card.querySelector(".forest-traces")!.querySelector(".forest-node-action")!.disabled, true);
    throw new Error("Model unavailable for this Turn");
  });
  ui.state.turns = [turn("1", 1), turn("2", 2), turn("3", 3)];
  ui.state.forestTurnCache.set("s", { loading: false, turns: structuredClone(ui.state.turns) });
  ui.state.expandedForestSessions.add("s");
  ui.renderForest();
  const card = ui.nodes.get("forest-canvas")!.querySelector(".forest-node")!;
  card.querySelector(".forest-traces")!.scrollTop = 45;
  await ui.generateSessionTraces();
  assert.equal(ui.nodes.get("forest-canvas")!.querySelector(".forest-node"), card);
  assert.equal(card.querySelector(".forest-traces")!.scrollTop, 45);
  assert.equal(ui.nodes.get("turn-list")!.scrollTop, 240);
  assert.equal(ui.state.turns[1].semanticTrace.displayText, "Already generated");
  assert.equal(card.querySelector(".forest-traces")!.querySelector(".forest-node-action")!.disabled, false);
  assert.match(ui.state.batchSummary.label, /1 generated.*1 failed.*1 current reused/);
  assert.equal(ui.state.forestTurnCache.get("s").turns[2].semanticTrace.freshness, "missing");
  assert.equal(calls.length, 4); // Two page reads and two generation requests; no refresh requests.
  ui.renderForest();
  assert.equal(ui.nodes.get("forest-canvas")!.querySelector(".forest-turn-count")!.textContent, "3 Turns · 2 Traces");
});

test("generation completing after Session navigation updates only its originating Session", async () => {
  let ui: ReturnType<typeof harness>;
  ui = harness((_path, options) => {
    if (options?.method !== "POST") return { data: [turn("1", 1)] };
    ui.state.selectedSession = { providerSessionId: "other" };
    ui.state.turns = [{ ...turn("1", 1), sessionId: "other" }];
    return { semanticTrace: trace("Origin only") };
  });
  await ui.generateSessionTraces();
  assert.equal(ui.state.forestTurnCache.get("s").turns[0].semanticTrace.displayText, "Origin only");
  assert.equal(ui.state.turns[0].semanticTrace.freshness, "missing");
  assert.equal(ui.state.batchGeneration, undefined);
});

test("single generation survives an older Show traces response arriving afterwards", async () => {
  let finishLoad!: (value: unknown) => void;
  const ui = harness((_path, options) => options?.method === "POST"
    ? { semanticTrace: trace("Fresh single trace") }
    : new Promise((resolve) => { finishLoad = resolve; }));
  ui.state.turns = [turn("1", 1)];
  const loading = ui.toggleForestTraces("s");
  const action = new Element();
  await ui.generateSemanticTrace(ui.state.turns[0], action);
  finishLoad({ data: [turn("1", 1)] });
  await loading;
  assert.equal(ui.state.forestTurnCache.get("s").turns[0].semanticTrace.displayText, "Fresh single trace");
  assert.equal(ui.nodes.get("forest-canvas")!.querySelectorAll(".forest-trace-item").length, 1);
});

test("batch results are not overwritten by an older Forest load", async () => {
  let finishLoad!: (value: unknown) => void;
  let reads = 0;
  const ui = harness((_path, options) => {
    if (options?.method === "POST") return { semanticTrace: trace("Fresh batch trace") };
    if (++reads === 1) return new Promise((resolve) => { finishLoad = resolve; });
    return { data: [turn("1", 1)] };
  });
  ui.state.turns = [turn("1", 1)];
  const loading = ui.toggleForestTraces("s");
  await ui.generateSessionTraces();
  finishLoad({ data: [turn("1", 1)] });
  await loading;
  assert.equal(ui.state.forestTurnCache.get("s").turns[0].semanticTrace.displayText, "Fresh batch trace");
  assert.equal(ui.nodes.get("forest-canvas")!.querySelectorAll(".forest-trace-item").length, 1);
});
