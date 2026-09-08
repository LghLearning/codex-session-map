import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { NativeLineage, Page, SemanticTraceLookup, Session, SessionProviderCapabilities, SessionProviderUpdate, Turn, TurnSemanticTrace, WorkspaceScope } from "../../../packages/core/src/index.ts";
import { createLocalWebServer, type LocalWebProvider, type LocalWebSemanticParentResult, type LocalWebSemanticParents, type LocalWebSemanticTitleRecord, type LocalWebSemanticTitles, type LocalWebSemanticTraces } from "../src/server.ts";
import { materializeSessionForest } from "../../../packages/forest/src/index.ts";
import { SqliteSemanticTraceStore } from "../../../packages/semantic-store/src/index.ts";
import type { WorkspaceOrganizationProgress, WorkspaceOrganizationResult } from "../../../packages/organizer/src/index.ts";

const scope: WorkspaceScope = {
  id: "cwd:scope/a",
  displayName: "Fixture workspace",
  canonicalRoot: "C:\\fixture",
  observedRoots: ["C:\\fixture"],
  source: "cwd",
  health: { state: "complete", issues: [] },
};

const sessions: Session[] = [session("visible-a", false), session("hidden-agent", true), session("visible-b", false)];

const turn: Turn = {
  providerId: "fixture",
  sessionId: "visible-a",
  nativeTurnId: "native-turn-a",
  displayOrdinal: 1,
  initiatorKind: "user",
  status: "completed",
  input: { text: "Fixture input", attachments: [] },
  assistantFinal: "Fixture answer",
  tools: [{ name: "fixture_tool", status: "completed", outputSummary: "done" }],
  partial: false,
  health: { state: "complete", issues: [] },
  provenance: [{ providerId: "fixture", tier: "primary", recordKey: "raw-key", completeness: "complete" }],
};

test("single-Turn API uses native IDs and full bodies without paging a capable provider", async (t) => {
  const provider: LocalWebProvider = new FakeProvider();
  const body = `# 原文\n\n${"背景内容。".repeat(200)}\n最终结论\n`;
  const fullTurn = { ...turn, nativeTurnId: "native/一%", input: { ...turn.input, text: body }, assistantFinal: body };
  const reads: string[][] = [];
  provider.listTurns = async () => { throw new Error("listTurns must not be used for exact reads"); };
  provider.readTurn = async (sessionId, nativeTurnId) => {
    reads.push([sessionId, nativeTurnId]);
    return sessionId === fullTurn.sessionId && nativeTurnId === fullTurn.nativeTurnId ? fullTurn : undefined;
  };
  const running = await createLocalWebServer({ provider, port: 0 }).start();
  t.after(() => running.close());
  const path = `/api/sessions/visible-a/turns/${encodeURIComponent(fullTurn.nativeTurnId)}`;
  const response = await fetch(`${running.url}${path}`);
  assert.equal(response.status, 200);
  const payload = await response.json() as { turn: { id: string; ordinal: number; input: string; assistantFinal: string } };
  assert.equal(payload.turn.id, fullTurn.nativeTurnId);
  assert.equal(payload.turn.ordinal, 1);
  assert.equal(payload.turn.input, body);
  assert.equal(payload.turn.assistantFinal, body);
  assert.deepEqual(reads, [["visible-a", fullTurn.nativeTurnId]]);
  assert.equal((await fetch(`${running.url}/api/sessions/visible-b/turns/${encodeURIComponent(fullTurn.nativeTurnId)}`)).status, 404);
  assert.equal((await fetch(`${running.url}/api/sessions/visible-a/turns/1`)).status, 404);
  assert.equal((await fetch(`${running.url}${path}`, { method: "POST" })).status, 405);
  provider.readTurn = async () => { throw new Error("source unavailable"); };
  assert.equal((await fetch(`${running.url}${path}`)).status, 500, "source errors must not be hidden as missing Turns");
});

test("single-Turn API retains paginated lookup for providers without readTurn", async (t) => {
  const provider: LocalWebProvider = new FakeProvider();
  const target = { ...turn, nativeTurnId: "last-native", displayOrdinal: 2 };
  const cursors: (string | undefined)[] = [];
  provider.listTurns = async (_sessionId, cursor) => {
    cursors.push(cursor);
    return cursor ? { data: [target] } : { data: [turn], nextCursor: "opaque-next" };
  };
  const running = await createLocalWebServer({ provider, port: 0 }).start();
  t.after(() => running.close());
  const response = await fetch(`${running.url}/api/sessions/visible-a/turns/last-native`);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { turn: { id: string } }).turn.id, target.nativeTurnId);
  assert.deepEqual(cursors, [undefined, "opaque-next"]);
  assert.equal((await fetch(`${running.url}/api/sessions/visible-a/turns/missing`)).status, 404);
});

test("Turn directory is lightweight and anchored manual placement validates native Turn membership", async (t) => {
  const provider = new FakeProvider();
  const store = new SqliteSemanticTraceStore();
  const running = await createLocalWebServer({ provider, userOverrides: store, port: 0 }).start();
  t.after(async () => { await running.close(); await store.close(); });
  const directory = await json(`${running.url}/api/sessions/visible-a/turn-directory`);
  assert.deepEqual(directory.data, [{ nativeTurnId: "native-turn-a", displayOrdinal: 1, displayLabel: "Fixture input" }]);
  assert.equal("input" in directory.data[0], false);
  assert.equal("assistantFinal" in directory.data[0], false);
  const write = async (value: unknown, revision: number, expected = 200) => {
    const response = await fetch(`${running.url}/api/sessions/visible-b/user-overrides/parent`, {
      method: "POST", headers: { Origin: running.url, "Content-Type": "application/json" }, body: JSON.stringify({ value, revision }),
    });
    assert.equal(response.status, expected, JSON.stringify(await response.clone().json()));
    return response.json() as Promise<any>;
  };
  const anchored = await write({ relation: "subtask", parentSessionId: "visible-a", anchorTurnId: "native-turn-a" }, 0);
  assert.equal(anchored.semanticParent.anchorTurnId, "native-turn-a");
  assert.equal(anchored.override.value.anchorTurnId, "native-turn-a");
  await write({ relation: "subtask", parentSessionId: "visible-a", anchorTurnId: "foreign-turn" }, 1, 400);
  const sessionLevel = await write({ relation: "continuation", parentSessionId: "visible-a" }, 1);
  assert.equal(sessionLevel.semanticParent.anchorTurnId, null, "changing placement without an anchor clears the old anchor atomically");
  const root = await write({ relation: "root" }, 2);
  assert.equal(root.semanticParent.parentSessionId, undefined);
  assert.equal(root.semanticParent.anchorTurnId, null);
});

test("local web API is loopback-only, paginated, read-only, and provider-neutral", async (t) => {
  const provider = new FakeProvider();
  const semanticTraces = new FakeSemanticTraces();
  const semanticTitles = new FakeSemanticTitles();
  const semanticParents = new FakeSemanticParents();
  let forestOptions: { includeBranches?: boolean } | undefined;
  const forest = { materialize: async (scopeId: string, options?: { includeBranches?: boolean }) => { forestOptions = options; return materializeSessionForest(scopeId, sessions.filter((item) => !item.excludedFromMainWorkspaceForest).map((item) => ({ session: item, turnCount: item.providerSessionId === "visible-a" ? 1 : 0, traceCount: 0 }))); } };
  const organizer = new FakeOrganizer();
  const environment = { version: "0.1.0-alpha", readOnly: true as const, ollama: { endpoint: "http://127.0.0.1:11434", available: true, model: "qwen3.5", thinking: "off" as const }, semanticStore: { available: true, path: "C:\\fixture\\semantic.sqlite", schemaVersion: 4 } };
  const running = await createLocalWebServer({ provider, semanticTraces, semanticTitles, semanticParents, forest, organizer, environment, port: 0, pageSize: 1 }).start();
  t.after(() => running.close());

  const health = await fetch(`${running.url}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.match(health.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const deepLink = await fetch(`${running.url}/workspaces/${encodeURIComponent(scope.id)}/sessions/visible-a/turns/native-turn-a`);
  assert.equal(deepLink.status, 200);
  assert.match(deepLink.headers.get("content-type") ?? "", /text\/html/);
  const invalidDeepLink = await fetch(`${running.url}/workspaces/missing/unexpected/path`);
  assert.equal(invalidDeepLink.status, 200, "the client must be able to render an invalid-route diagnostic");

  const bootstrap = await json(`${running.url}/api/bootstrap`);
  assert.equal(bootstrap.scopes[0].id, scope.id);
  assert.equal(bootstrap.capabilities.openTurn, false);
  assert.equal(bootstrap.semanticTraces.available, true);
  assert.equal(bootstrap.semanticTraces.mode, "manual_preview");
  assert.equal(bootstrap.semanticTitles.available, true);
  assert.equal(bootstrap.semanticTitles.mode, "manual_current_session");
  assert.equal(bootstrap.semanticParents.mode, "manual_current_session");
  assert.deepEqual(bootstrap.semanticParents.relations, ["continuation", "subtask", "root"]);
  assert.equal(bootstrap.forest.available, true);
  assert.equal(bootstrap.forest.mode, "deterministic_projection");
  assert.equal(bootstrap.forest.openSessionSupported, false);
  assert.equal(bootstrap.organizer.available, true);
  assert.equal(bootstrap.environment.version, "0.1.0-alpha");

  const sessionsPage = await json(`${running.url}/api/scopes/${encodeURIComponent(scope.id)}/sessions`);
  assert.equal(sessionsPage.data.length, 1);
  assert.equal(sessionsPage.data[0].providerSessionId, "visible-a");
  assert.equal(sessionsPage.data[0].displayTitle, "visible-a");
  assert.equal(sessionsPage.data[0].originalTitle, "visible-a");
  assert.ok(sessionsPage.nextCursor);
  const nextPage = await json(`${running.url}/api/scopes/${encodeURIComponent(scope.id)}/sessions?cursor=${encodeURIComponent(sessionsPage.nextCursor)}`);
  assert.equal(nextPage.data[0].providerSessionId, "visible-b");

  const hiddenPage = await json(`${running.url}/api/scopes/${encodeURIComponent(scope.id)}/sessions?includeHidden=1`);
  assert.equal(hiddenPage.data.length, 1);
  assert.ok(sessions.some((item) => item.providerSessionId === "hidden-agent"));

  const projectedForest = await json(`${running.url}/api/scopes/${encodeURIComponent(scope.id)}/forest`);
  assert.equal(projectedForest.forest.stats.sessions, 2);
  assert.equal(projectedForest.forest.stats.confirmedRoots, 0);
  assert.equal(projectedForest.forest.stats.unorganized, 2);
  assert.equal(projectedForest.forest.unorganized.some((node: any) => node.sessionId === "visible-a"), true);
  assert.equal(forestOptions?.includeBranches, true);
  await json(`${running.url}/api/scopes/${encodeURIComponent(scope.id)}/forest?branches=0`);
  assert.equal(forestOptions?.includeBranches, false);

  const organizeResponse = await fetch(`${running.url}/api/scopes/${encodeURIComponent(scope.id)}/organize`, { method: "POST", headers: { Origin: running.url } });
  assert.equal(organizeResponse.status, 202);
  const organizeStarted = await organizeResponse.json() as any;
  let organizeJob = organizeStarted.job;
  for (let attempt = 0; attempt < 20 && organizeJob.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    organizeJob = (await json(`${running.url}/api/organize/${organizeJob.id}`)).job;
  }
  assert.equal(organizeJob.status, "completed");
  assert.equal(organizer.calls, 1);

  const turns = await json(`${running.url}/api/sessions/visible-a/turns`);
  assert.equal(turns.data[0].id, "native-turn-a");
  assert.equal(turns.data[0].tools[0].name, "fixture_tool");
  assert.equal("provenance" in turns.data[0], false);
  assert.equal(turns.data[0].semanticTrace.freshness, "missing");

  const generated = await json(`${running.url}/api/sessions/visible-a/turns/native-turn-a/semantic-trace`, { method: "POST", headers: { Origin: running.url } });
  assert.equal(generated.semanticTrace.text, "Fixture semantic trace");
  assert.equal(generated.semanticTrace.safetyWarning, true);
  assert.equal(semanticTraces.ensureCount, 1);

  const edited = await json(`${running.url}/api/sessions/visible-a/turns/native-turn-a/semantic-trace/review`, {
    method: "POST",
    headers: { Origin: running.url, "Content-Type": "application/json" },
    body: JSON.stringify({ verdict: "edited", editedText: "User corrected trace" }),
  });
  assert.equal(edited.semanticTrace.displayText, "User corrected trace");
  assert.equal(edited.semanticTrace.aiOriginalText, "Fixture semantic trace");
  assert.equal(edited.semanticTrace.userFeedback.verdict, "edited");

  const regenerated = await json(`${running.url}/api/sessions/visible-a/turns/native-turn-a/semantic-trace?force=1`, { method: "POST", headers: { Origin: running.url } });
  assert.equal(regenerated.semanticTrace.aiOriginalText, "Regenerated fixture trace");
  assert.equal(regenerated.semanticTrace.displayText, "User corrected trace", "AI regeneration must not overwrite the user edit");
  assert.equal(regenerated.semanticTrace.userFeedback.verdict, "edited");

  const accepted = await json(`${running.url}/api/sessions/visible-a/turns/native-turn-a/semantic-trace/review`, {
    method: "POST",
    headers: { Origin: running.url, "Content-Type": "application/json" },
    body: JSON.stringify({ verdict: "accepted" }),
  });
  assert.equal(accepted.semanticTrace.userFeedback.verdict, "accepted");
  assert.equal(accepted.semanticTrace.displayText, "Regenerated fixture trace");

  const rejected = await json(`${running.url}/api/sessions/visible-a/turns/native-turn-a/semantic-trace/review`, {
    method: "POST",
    headers: { Origin: running.url, "Content-Type": "application/json" },
    body: JSON.stringify({ verdict: "rejected" }),
  });
  assert.equal(rejected.semanticTrace.userFeedback.verdict, "rejected");
  assert.equal(rejected.semanticTrace.displayText, "Regenerated fixture trace");

  const titleGenerated = await json(`${running.url}/api/sessions/visible-a/semantic-title`, { method: "POST", headers: { Origin: running.url } });
  assert.equal(titleGenerated.semanticTitle.generatedTitle, "Fixture semantic Session title 1");
  assert.equal(titleGenerated.semanticTitle.displayTitle, "Fixture semantic Session title 1");
  assert.equal(sessions[0]?.title, "visible-a", "Semantic Title generation must not mutate the upstream Core Session");

  const titleEdited = await json(`${running.url}/api/sessions/visible-a/semantic-title/edit`, {
    method: "POST",
    headers: { Origin: running.url, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "User Session title" }),
  });
  assert.equal(titleEdited.semanticTitle.userTitle, "User Session title");
  assert.equal(titleEdited.semanticTitle.displayTitle, "User Session title");

  const titleRegenerated = await json(`${running.url}/api/sessions/visible-a/semantic-title`, { method: "POST", headers: { Origin: running.url } });
  assert.equal(titleRegenerated.semanticTitle.generatedTitle, "Fixture semantic Session title 2");
  assert.equal(titleRegenerated.semanticTitle.displayTitle, "User Session title", "AI regeneration must not overwrite the user Session title");
  const titledSessions = await json(`${running.url}/api/scopes/${encodeURIComponent(scope.id)}/sessions`);
  assert.equal(titledSessions.data[0].displayTitle, "User Session title");
  assert.equal(titledSessions.data[0].title, "visible-a");

  const parentMissing = await json(`${running.url}/api/sessions/visible-a/semantic-parent`);
  assert.equal(parentMissing.semanticParent.freshness, "missing");
  assert.equal(parentMissing.semanticParent.candidates[0].sessionId, "visible-b");
  const parentGenerated = await json(`${running.url}/api/sessions/visible-a/semantic-parent`, { method: "POST", headers: { Origin: running.url } });
  assert.equal(parentGenerated.semanticParent.relation, "continuation");
  assert.equal(parentGenerated.semanticParent.authority, "ai");
  const parentRooted = await json(`${running.url}/api/sessions/visible-a/semantic-parent/review`, {
    method: "POST",
    headers: { Origin: running.url, "Content-Type": "application/json" },
    body: JSON.stringify({ relation: "root" }),
  });
  assert.equal(parentRooted.semanticParent.relation, "root");
  assert.equal(parentRooted.semanticParent.authority, "user");
  const parentRegenerated = await json(`${running.url}/api/sessions/visible-a/semantic-parent`, { method: "POST", headers: { Origin: running.url } });
  assert.equal(parentRegenerated.semanticParent.generatedRelation, "subtask");
  assert.equal(parentRegenerated.semanticParent.relation, "root", "AI regeneration must preserve the user semantic placement");
  assert.equal(provider.nativeLineage.parentSessionId, "native-parent", "Semantic Parent operations must not modify Native Lineage");

  const denied = await fetch(`${running.url}/api/refresh`, { method: "POST", headers: { Origin: "https://example.invalid" } });
  assert.equal(denied.status, 403);
  const refreshed = await fetch(`${running.url}/api/refresh`, { method: "POST", headers: { Origin: running.url } });
  assert.equal(refreshed.status, 200);
  assert.equal(provider.refreshCount, 1);

  const mutation = await fetch(`${running.url}/api/sessions/visible-a`, { method: "DELETE" });
  assert.equal(mutation.status, 405);

  const eventAbort = new AbortController();
  const eventResponse = await fetch(`${running.url}/api/events`, { signal: eventAbort.signal });
  assert.match(eventResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = eventResponse.body!.getReader();
  assert.match(await readEvent(reader), /event: ready/);
  provider.emit({ revision: 1, reason: "source_change", occurredAt: "2026-01-01T00:00:00.000Z" });
  assert.match(await readEvent(reader), /"revision":1/);
  eventAbort.abort();
});

test("static UI uses external assets and never injects transcript HTML", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(html, /Workspace/);
  assert.match(html, /Sessions/);
  assert.match(script, /popstate/);
  assert.match(html, /semantic trace/i);
  assert.match(script, /Generate trace/);
  assert.match(html, /Generate missing traces/);
  assert.match(script, /Accept/);
  assert.match(script, /Edit/);
  assert.match(script, /Reject/);
  assert.match(html, /semantic-title-panel/);
  assert.match(script, /Generate title/);
  assert.match(script, /session\.displayTitle \?\? session\.title/);
  assert.match(html, /semantic-parent-panel/);
  assert.match(script, /Infer parent/);
  assert.match(script, /Set root/);
  assert.match(html, /Editable Session Forest/);
  assert.match(script, /materialize existing data/);
  assert.match(script, /Show traces/);
  assert.match(script, /fitForestToView/);
  assert.match(html, /Organize Workspace/);
  assert.match(script, /Unorganized/);
  assert.doesNotMatch(script, /semanticTrace\?\.displayText \? "forest-trace-text" : "forest-trace-missing"/);
  assert.doesNotMatch(script, /codex:\/\/threads/i, "the UI must not invent an unsupported Codex deep link");
  assert.match(script, /freshness === "missing" \|\| turn\.semanticTrace\?\.freshness === "stale"/);
});

test("existing Forest remains available when Ollama generation is offline", async (t) => {
  const provider = new FakeProvider();
  const forest = { materialize: async (scopeId: string) => materializeSessionForest(scopeId, sessions.filter((item) => !item.excludedFromMainWorkspaceForest).map((item) => ({ session: item, turnCount: 0, traceCount: 0 }))) };
  const running = await createLocalWebServer({ provider, forest, port: 0 }).start();
  t.after(() => running.close());
  const bootstrap = await json(`${running.url}/api/bootstrap`);
  assert.equal(bootstrap.semanticTraces.available, false);
  assert.equal(bootstrap.organizer.available, false);
  assert.equal(bootstrap.forest.available, true);
  const projected = await json(`${running.url}/api/scopes/${encodeURIComponent(scope.id)}/forest`);
  assert.equal(projected.forest.stats.sessions, 2);
  assert.equal(projected.forest.stats.unorganized, 2);
});

test("offline model blocks generation but preserves semantic reading and correction", async (t) => {
  const semanticTraces = new FakeSemanticTraces();
  const semanticTitles = new FakeSemanticTitles();
  const semanticParents = new FakeSemanticParents();
  await semanticTraces.ensure(turn);
  await semanticTitles.generate();
  await semanticParents.generate();
  const running = await createLocalWebServer({
    provider: new FakeProvider(), semanticTraces, semanticTitles, semanticParents,
    semanticGenerationAvailable: false, port: 0,
  }).start();
  t.after(() => running.close());
  const bootstrap = await json(`${running.url}/api/bootstrap`);
  for (const name of ["semanticTraces", "semanticTitles", "semanticParents"]) {
    assert.equal(bootstrap[name].available, true);
    assert.equal(bootstrap[name].generationAvailable, false);
  }
  const post = (body?: object) => ({ method: "POST", headers: { Origin: running.url, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const base = `${running.url}/api/sessions/visible-a`;
  for (const path of ["semantic-title", "semantic-parent", "turns/native-turn-a/semantic-trace"]) {
    assert.equal((await fetch(`${base}/${path}`, post())).status, 503);
  }
  const title = await json(`${base}/semantic-title/edit`, post({ title: "离线用户标题" }));
  assert.equal(title.semanticTitle.displayTitle, "离线用户标题");
  const parent = await json(`${base}/semantic-parent/review`, post({ relation: "root" }));
  assert.equal(parent.semanticParent.authority, "user");
  const trace = await json(`${base}/turns/native-turn-a/semantic-trace/review`, post({ verdict: "edited", editedText: "离线用户摘要" }));
  assert.equal(trace.semanticTrace.displayText, "离线用户摘要");
  assert.equal((await json(`${base}/semantic-title`)).semanticTitle.displayTitle, "离线用户标题");
  assert.equal((await json(`${base}/semantic-parent`)).semanticParent.relation, "root");
  assert.equal(semanticTraces.ensureCount, 1);
  assert.equal(semanticTitles.generation, 1);
  assert.equal(semanticParents.generation, 1);
});

class FakeOrganizer {
  calls = 0;
  async organize(_scopeId: string, options: { signal: AbortSignal; onProgress(progress: WorkspaceOrganizationProgress): void }): Promise<WorkspaceOrganizationResult> {
    this.calls += 1;
    const result: WorkspaceOrganizationResult = {
      phase: options.signal.aborted ? "cancelled" : "completed", sessions: 2, titlesProcessed: 2, titlesGenerated: 1,
      relationshipsProcessed: 2, relationshipsGenerated: 1, warnings: 0, cancelled: options.signal.aborted, warningDetails: [],
    };
    options.onProgress(result);
    return result;
  }
}

class FakeSemanticTraces implements LocalWebSemanticTraces {
  ensureCount = 0;
  trace?: TurnSemanticTrace;
  async inspect(_turn: Turn): Promise<SemanticTraceLookup> {
    return { freshness: this.trace ? "current" : "missing", trace: this.trace, currentInputFingerprint: "fixture-fingerprint" };
  }
  async ensure(value: Turn): Promise<TurnSemanticTrace> {
    this.ensureCount += 1;
    this.trace = {
      providerId: value.providerId,
      sessionId: value.sessionId,
      nativeTurnId: value.nativeTurnId,
      text: "Fixture semantic trace",
      inputFingerprint: "fixture-fingerprint",
      generator: { id: "fixture", version: "1", model: "fixture-model" },
      generatedAt: "2026-08-31T00:00:00.000Z",
    };
    return this.trace;
  }
  async regenerate(value: Turn): Promise<TurnSemanticTrace> {
    this.trace = {
      ...(await this.ensure(value)),
      text: "Regenerated fixture trace",
      generatedAt: "2026-09-01T00:00:00.000Z",
    };
    return this.trace;
  }
  inspectSafety() { return { warning: true, languageMismatch: false }; }
  feedback?: { verdict: "accepted" | "edited" | "rejected"; aiOriginalText: string; editedText?: string; sourceFingerprint: string; reviewedAt: string };
  async getUserFeedback() { return this.feedback; }
  async putUserFeedback(_turn: Turn, feedback: NonNullable<FakeSemanticTraces["feedback"]>) { this.feedback = feedback; }
}

class FakeSemanticTitles implements LocalWebSemanticTitles {
  generation = 0;
  record?: LocalWebSemanticTitleRecord;
  async readStored() { return this.record; }
  async inspect() {
    return { freshness: this.record ? "current" as const : "missing" as const, title: this.record, currentSourceFingerprint: "title-source" };
  }
  async generate() {
    this.generation += 1;
    this.record = {
      generatedTitle: `Fixture semantic Session title ${this.generation}`,
      userTitle: this.record?.userTitle,
      generator: { id: "title", version: "1", model: "fixture-model" },
      sourceFingerprint: "title-source",
      generatedAt: `2026-09-01T00:0${this.generation}:00.000Z`,
      userEditedAt: this.record?.userEditedAt,
    };
    return this.record;
  }
  async edit(_session: Session, userTitle: string) {
    if (!this.record) throw new Error("missing title");
    this.record = { ...this.record, userTitle, userEditedAt: "2026-09-01T00:03:00.000Z" };
    return this.record;
  }
}

class FakeSemanticParents implements LocalWebSemanticParents {
  generation = 0;
  edge?: LocalWebSemanticParentResult["edge"];
  readonly candidate = {
    projection: { providerId: "fixture", sessionId: "visible-b", workspaceScopeId: scope.id, createdAt: "2026-08-01T00:00:00.000Z", originalTitle: "visible-b", representativeTraces: [] },
    score: 0.8,
    signals: ["text_overlap"],
  };
  readonly lineage = { providerId: "fixture", sessionId: "visible-a", parentSessionId: "native-parent", kind: "user_fork" as const, recovery: "session_only" as const };
  async inspect(): Promise<LocalWebSemanticParentResult> {
    return { lookup: { freshness: this.edge ? "current" : "missing", edge: this.edge, currentSourceFingerprint: "parent-source" }, candidates: [this.candidate], nativeLineage: this.lineage };
  }
  async generate(): Promise<LocalWebSemanticParentResult> {
    this.generation += 1;
    this.edge = {
      providerId: "fixture", childSessionId: "visible-a", generatedParentSessionId: "visible-b",
      generatedRelation: this.generation === 1 ? "continuation" : "subtask",
      generatedReason: "Fixture relationship", generator: { id: "parent", version: "1", model: "qwen3.5" },
      sourceFingerprint: "parent-source", generatedAt: "2026-09-01T00:00:00.000Z",
      userParentSessionId: this.edge?.userParentSessionId, userRelation: this.edge?.userRelation, userReviewedAt: this.edge?.userReviewedAt,
    };
    return { ...(await this.inspect()), edge: this.edge };
  }
  async review(_session: Session, review: { parentSessionId?: string; anchorTurnId?: string; relation: "continuation" | "subtask" | "root" }): Promise<LocalWebSemanticParentResult> {
    if (!this.edge) throw new Error("missing edge");
    this.edge = { ...this.edge, userParentSessionId: review.parentSessionId, userAnchorTurnId: review.anchorTurnId, userRelation: review.relation, userReviewedAt: "2026-09-01T00:01:00.000Z" };
    return { ...(await this.inspect()), edge: this.edge };
  }
}

class FakeProvider implements LocalWebProvider {
  refreshCount = 0;
  readonly listeners = new Set<(update: SessionProviderUpdate) => void>();
  readonly nativeLineage = { providerId: "fixture", sessionId: "visible-a", parentSessionId: "native-parent", kind: "user_fork" as const, recovery: "session_only" as const };
  async getCapabilities(): Promise<SessionProviderCapabilities> {
    return { nativeLineage: "none", openSession: false, openTurn: false, liveUpdates: true, titleRead: true, titleWrite: false, archiveRead: true };
  }
  async listWorkspaceScopes(): Promise<readonly WorkspaceScope[]> { return [scope]; }
  async listSessions(scopeId: string): Promise<Page<Session>> { return { data: scopeId === scope.id ? sessions : [] }; }
  async readSession(sessionId: string): Promise<Session> {
    const value = sessions.find((item) => item.providerSessionId === sessionId);
    if (!value) throw new Error("Unknown session");
    return value;
  }
  async listTurns(sessionId: string): Promise<Page<Turn>> { return { data: sessionId === "visible-a" ? [turn] : [] }; }
  async getNativeLineage(_sessionId: string): Promise<NativeLineage | null> { return this.nativeLineage; }
  getDiagnostics() { return [{ code: "partial_line", severity: "warning" as const, message: "An incomplete fixture line remains visible." }]; }
  async refresh(): Promise<void> { this.refreshCount += 1; }
  async subscribeUpdates(listener: (update: SessionProviderUpdate) => void): Promise<() => void> {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(update: SessionProviderUpdate): void { for (const listener of this.listeners) listener(update); }
}

function session(id: string, hidden: boolean): Session {
  return {
    providerId: "fixture",
    providerSessionId: id,
    workspaceScopeId: scope.id,
    title: id,
    createdAt: id === "visible-a" ? "2026-01-01T00:00:00.000Z" : "2026-01-02T00:00:00.000Z",
    archiveStatus: "active",
    sourceKind: hidden ? "agent" : "interactive",
    excludedFromMainWorkspaceForest: hidden,
    nativeLineageAvailability: "none",
    health: { state: "complete", issues: [] },
    provenance: [{ providerId: "fixture", tier: "primary", completeness: "complete" }],
  };
}

async function json(url: string, options?: RequestInit): Promise<any> {
  const response = await fetch(url, options);
  assert.equal(response.status, 200);
  return response.json();
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let value = "";
  while (!value.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    value += decoder.decode(chunk.value, { stream: true });
  }
  return value;
}
