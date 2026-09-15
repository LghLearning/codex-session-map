import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Session, Turn } from "../../core/src/index.ts";
import { materializeSessionForest } from "../../forest/src/index.ts";
import { SqliteSemanticTraceStore, SemanticSessionTitleService, TurnSemanticTraceService, SemanticParentService, preferredSemanticParent, buildSemanticSessionProjection, selectSemanticParentCandidates, type UserField, type UserValue } from "../src/index.ts";

const identity = { id: "fixture", version: "1", model: "test" };
function session(id: string, time = "2026-01-01T00:00:00Z"): Session {
  return { providerId: "fixture", providerSessionId: id, workspaceScopeId: "workspace", title: `Original ${id}`, createdAt: time, archiveStatus: "active", sourceKind: "interactive", excludedFromMainWorkspaceForest: false, nativeLineageAvailability: "none", health: { state: "complete", issues: [] }, provenance: [] };
}
const sessions = [session("a"), session("b")];
const turn: Turn = { providerId: "fixture", sessionId: "b", nativeTurnId: "native/1", displayOrdinal: 1, initiatorKind: "user", status: "completed", input: { text: "Raw input", attachments: [] }, tools: [], partial: false, health: { state: "complete", issues: [] }, provenance: [] };
const key = (field: UserField) => ({ providerId: "fixture", sessionId: "b", field, nativeTurnId: field === "label" ? turn.nativeTurnId : undefined });
const titleSource = { providerId: "fixture", sessionId: "b", originalTitle: "Original", semanticTraces: [], fallbackTurns: [] };
const parentSource = { current: buildSemanticSessionProjection({ session: sessions[1], traceTexts: [] }), candidates: [{ projection: buildSemanticSessionProjection({ session: sessions[0], traceTexts: [] }), score: 1, signals: [] }] };

for (const field of ["title", "label", "parent"] as const) test(`${field}: independent state persists, survives AI generation and regeneration, and restores automatic`, async () => {
  const path = join(await mkdtemp(join(tmpdir(), "map-b-authority-")), "store.sqlite");
  let store = new SqliteSemanticTraceStore(path);
  const value: UserValue = field === "title" ? { title: "Manual title" } : field === "label" ? { label: "Manual label" } : { relation: "subtask", parentSessionId: "a" };
  store.overrides.write(key(field), "workspace", value, 0, sessions);
  await store.close();
  store = new SqliteSemanticTraceStore(path);
  assert.deepEqual(store.overrides.read(key(field))?.value, value);
  assert.equal((await store.getSessionTitle("fixture", "b"))?.generatedTitle, undefined);
  assert.equal(await store.get(turn), undefined);
  assert.equal((await store.getSemanticParent("fixture", "b"))?.generatedRelation, undefined);
  let number = 0;
  const titles = new SemanticSessionTitleService({ store, generator: { identity, generate: async () => ({ title: `AI ${++number}` }) } });
  const traces = new TurnSemanticTraceService({ store, generator: { identity, generate: async () => ({ text: `AI ${++number}` }) } });
  const parents = new SemanticParentService({ store, generator: { identity, generate: async () => ({ relation: "continuation", parentSessionId: "a", reason: `AI ${++number}` }) } });
  for (let i = 0; i < 2; i++) {
    if (field === "title") assert.equal((await titles.generate(titleSource)).userTitle, "Manual title");
    if (field === "label") { await traces.regenerate(turn); assert.equal((await store.getUserFeedback(turn))?.editedText, "Manual label"); }
    if (field === "parent") assert.equal(preferredSemanticParent(await parents.generate(parentSource, sessions)).relation, "subtask");
    assert.deepEqual(store.overrides.read(key(field))?.value, value);
  }
  const restore = store.overrides.write(key(field), "workspace", null, 1, sessions);
  assert.equal(restore.before && Object.keys(restore.before).length > 0, true);
  if (field === "title") { const title = await store.getSessionTitle("fixture", "b"); assert.equal(title?.userTitle, undefined); assert.equal(title?.generatedTitle, "AI 2"); }
  if (field === "label") { assert.equal(await store.getUserFeedback(turn), undefined); assert.equal((await store.get(turn))?.text, "AI 2"); }
  if (field === "parent") assert.equal(preferredSemanticParent((await store.getSemanticParent("fixture", "b"))!).authority, "ai");
  store.overrides.undo(restore.id, restore.revision, "workspace", sessions);
  assert.deepEqual(store.overrides.read(key(field))?.value, value, "restoring automatic is itself undoable");
  await store.close();
});

for (const [name, field, value] of [
  ["rename", "title", { title: "Manual" }], ["label", "label", { label: "Manual" }],
  ["move", "parent", { relation: "continuation", parentSessionId: "a" }], ["root", "parent", { relation: "root" }],
] as const) test(`${name}: Undo restores absent override and cannot be replayed`, async () => {
  const store = new SqliteSemanticTraceStore();
  const edit = store.overrides.write(key(field), "workspace", value, 0, sessions);
  store.overrides.undo(edit.id, edit.revision, "workspace", sessions);
  assert.equal(store.overrides.read(key(field))?.value, null);
  assert.equal(store.overrides.read(key(field))?.revision, 2);
  assert.throws(() => store.overrides.undo(edit.id, edit.revision, "workspace", sessions), /changed again/);
  await store.close();
});

test("revision conflicts across database connections block stale edits and stale Undo", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "map-b-revisions-")), "store.sqlite");
  const first = new SqliteSemanticTraceStore(path), second = new SqliteSemanticTraceStore(path);
  const edit = first.overrides.write(key("title"), "workspace", { title: "Y" }, 0);
  second.overrides.write(key("title"), "workspace", { title: "Z" }, 1);
  assert.throws(() => first.overrides.undo(edit.id, 1, "workspace", sessions), /changed again/);
  assert.throws(() => first.overrides.write(key("title"), "workspace", { title: "X" }, 1), /changed again/);
  assert.equal(first.overrides.read(key("title"))?.value?.title, "Z");
  await first.close(); await second.close();
});

test("anchored Semantic Placement is atomic, persistent, undoable, and independent from Turn labels", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "map-b5-anchor-")), "store.sqlite");
  const values = [session("a"), session("b", "2026-02-01T00:00:00Z"), session("c")];
  let store = new SqliteSemanticTraceStore(path);
  const parentKey = key("parent");
  const first = store.overrides.write(parentKey, "workspace", { relation: "subtask", parentSessionId: "a", anchorTurnId: "a/native-3" }, 0, values);
  assert.deepEqual((await store.getSemanticParent("fixture", "b")) && preferredSemanticParent((await store.getSemanticParent("fixture", "b"))!), {
    parentSessionId: "a", anchorTurnId: "a/native-3", relation: "subtask", authority: "user",
  });
  await store.close();
  store = new SqliteSemanticTraceStore(path);
  const parents = new SemanticParentService({ store, generator: { identity, generate: async () => ({ relation: "continuation", parentSessionId: "a", reason: "AI changed" }) } });
  await parents.generate(parentSource, values);
  assert.equal(preferredSemanticParent((await store.getSemanticParent("fixture", "b"))!).anchorTurnId, "a/native-3", "AI regeneration preserves the user anchor");
  const traces = new TurnSemanticTraceService({ store, generator: { identity, generate: async () => ({ text: "AI trace changed" }) } });
  await traces.regenerate(turn);
  assert.equal(store.overrides.read(parentKey)?.value?.anchorTurnId, "a/native-3", "Trace regeneration cannot change topology");
  const move = store.overrides.write(parentKey, "workspace", { relation: "continuation", parentSessionId: "c", anchorTurnId: "c/native-7" }, first.revision, values);
  assert.deepEqual(store.overrides.read(parentKey)?.value, { relation: "continuation", parentSessionId: "c", anchorTurnId: "c/native-7" });
  store.overrides.write(key("label"), "workspace", { label: "Changed navigation text" }, 0, values);
  assert.equal(store.overrides.read(parentKey)?.value?.anchorTurnId, "c/native-7");
  store.overrides.undo(move.id, move.revision, "workspace", values);
  assert.deepEqual(store.overrides.read(parentKey)?.value, { relation: "subtask", parentSessionId: "a", anchorTurnId: "a/native-3" });
  assert.throws(() => store.overrides.write(parentKey, "workspace", { relation: "root", anchorTurnId: "a/native-3" }, 3, values), /root.*anchor/i);
  const rooted = store.overrides.write(parentKey, "workspace", { relation: "root" }, 3, values);
  assert.deepEqual(store.overrides.read(parentKey)?.value, { relation: "root" });
  store.overrides.undo(rooted.id, rooted.revision, "workspace", values);
  assert.equal(store.overrides.read(parentKey)?.value?.anchorTurnId, "a/native-3");
  await store.close();
});

test("recovered Turn identity migration preserves traces, labels, anchors, and Undo history atomically", async () => {
  const store = new SqliteSemanticTraceStore();
  const oldLabel = "recovered:legacy-label";
  const newLabel = "recovered:v2:new-label";
  const oldAnchor = "recovered:legacy-anchor";
  const newAnchor = "recovered:v2:new-anchor";
  await store.put({ ...turn, nativeTurnId: oldLabel, text: "Stored trace", inputFingerprint: "input", generator: identity, generatedAt: "2026-01-01" });
  store.overrides.write({ ...key("label"), nativeTurnId: oldLabel }, "workspace", { label: "Manual label" }, 0, sessions);
  const parentKey = { ...key("parent"), nativeTurnId: undefined };
  store.overrides.write(parentKey, "workspace", { relation: "subtask", parentSessionId: "a", anchorTurnId: oldAnchor }, 0, sessions);

  const report = await store.migrateTurnIdentityReferences([
    { providerId: "fixture", sessionId: "b", oldNativeTurnId: oldLabel, newNativeTurnId: newLabel },
    { providerId: "fixture", sessionId: "a", oldNativeTurnId: oldAnchor, newNativeTurnId: newAnchor },
  ]);
  assert.equal(report.tracesMoved, 1);
  assert.equal(report.overridesMoved, 1);
  assert.equal(report.historyMoved, 1);
  assert.equal(report.anchorsMoved, 2, "override and history anchor JSON are both migrated");
  assert.equal((await store.get({ providerId: "fixture", sessionId: "b", nativeTurnId: oldLabel })), undefined);
  assert.equal((await store.get({ providerId: "fixture", sessionId: "b", nativeTurnId: newLabel }))?.text, "Stored trace");
  assert.equal(store.overrides.read({ ...key("label"), nativeTurnId: newLabel })?.value?.label, "Manual label");
  assert.equal((await store.getSemanticParent("fixture", "b"))?.userAnchorTurnId, newAnchor);
  await store.close();

  const collision = new SqliteSemanticTraceStore();
  await collision.put({ ...turn, nativeTurnId: oldLabel, text: "old", inputFingerprint: "old", generator: identity, generatedAt: "2026-01-01" });
  await collision.put({ ...turn, nativeTurnId: newLabel, text: "new", inputFingerprint: "new", generator: identity, generatedAt: "2026-01-01" });
  await assert.rejects(() => collision.migrateTurnIdentityReferences([{ providerId: "fixture", sessionId: "b", oldNativeTurnId: oldLabel, newNativeTurnId: newLabel }]), /collision/);
  assert.equal((await collision.get({ providerId: "fixture", sessionId: "b", nativeTurnId: oldLabel }))?.text, "old", "collision rollback keeps the old row");
  await collision.close();
});

test("manual parents cover more than AI Top-K, while future, self, workspace and cycle checks remain enforced", async () => {
  const store = new SqliteSemanticTraceStore();
  const values = [...Array.from({ length: 12 }, (_, i) => session(`parent-${i}`)), session("b", "2026-02-01T00:00:00Z"), session("future", "2026-03-01T00:00:00Z"), { ...session("other"), workspaceScopeId: "other" }];
  const current = values.find((value) => value.providerSessionId === "b")!;
  const projections = values.map((value) => buildSemanticSessionProjection({ session: value, traceTexts: [] }));
  const ai = selectSemanticParentCandidates({ current: projections[12], sessions: projections, nativeLineage: null });
  assert.equal(ai.length, 8);
  const legal = store.overrides.manualCandidates(current, values);
  assert.equal(legal.length, 12);
  const outside = legal.find((item) => !ai.some((candidate) => candidate.projection.sessionId === item.sessionId))!;
  store.overrides.write(key("parent"), "workspace", { relation: "continuation", parentSessionId: outside.sessionId }, 0, values);
  assert.equal(store.overrides.manualCandidates(current, values, outside.title).length, 1);
  assert.throws(() => store.overrides.write(key("parent"), "workspace", { relation: "subtask", parentSessionId: "future" }, 1, values), /no later/);
  assert.throws(() => store.overrides.write(key("parent"), "workspace", { relation: "subtask", parentSessionId: "b" }, 1, values), /different/);
  assert.throws(() => store.overrides.write(key("parent"), "workspace", { relation: "subtask", parentSessionId: "other" }, 1, values), /Workspace/);
  await store.close();
  const cycleStore = new SqliteSemanticTraceStore();
  const service = new SemanticParentService({ store: cycleStore, generator: { identity, generate: async () => { throw new Error("AI must not run"); } } });
  await service.review({ providerId: "fixture", childSessionId: "b", relation: "subtask", parentSessionId: "a", sessions });
  assert.throws(() => cycleStore.overrides.write({ ...key("parent"), sessionId: "a" }, "workspace", { relation: "continuation", parentSessionId: "b" }, 0, sessions), /cycle/);
  assert.equal(cycleStore.overrides.manualCandidates(sessions[0], sessions).length, 0);
  await cycleStore.close();
});

test("Forest consumes user-only titles and placement, distinguishing user root from AI root and Unorganized", async () => {
  const store = new SqliteSemanticTraceStore();
  await store.putUserSessionTitle("fixture", "b", "User only", "2026-01-01");
  await store.putUserSemanticParent("fixture", "b", undefined, "root", "2026-01-01");
  const forest = materializeSessionForest("workspace", await Promise.all(sessions.map(async (session) => ({ session, semanticTitle: await store.getSessionTitle("fixture", session.providerSessionId), semanticParent: await store.getSemanticParent("fixture", session.providerSessionId), turnCount: 0, traceCount: 0 }))));
  assert.equal(forest.roots[0].displayTitle, "User only");
  assert.equal(forest.roots[0].placementSource, "user");
  assert.equal(forest.unorganized[0].sessionId, "a");
  await store.close();
});

async function legacyDatabase(path: string) {
  const store = new SqliteSemanticTraceStore(path);
  await store.putGeneratedSessionTitle({ providerId: "fixture", sessionId: "b", generatedTitle: "AI", generator: identity, sourceFingerprint: "v4", generatedAt: "2026-01-01" });
  await store.putGeneratedSemanticParent({ providerId: "fixture", childSessionId: "b", generatedRelation: "root", generatedReason: "AI", generator: identity, sourceFingerprint: "v4", generatedAt: "2026-01-01" });
  await store.close();
  const db = new DatabaseSync(path);
  db.exec("DROP TABLE user_edit_history; DROP TABLE user_overrides; PRAGMA user_version=4; UPDATE session_semantic_titles SET user_title='Legacy user title'; UPDATE session_semantic_edges SET user_relation='subtask',user_parent_session_id='a';");
  for (const verdict of ["accepted", "edited", "rejected"]) db.prepare("INSERT INTO turn_semantic_trace_feedback VALUES ('fixture','b',?,?,'AI original',?,'source','2026-01-01')").run(verdict, verdict, verdict === "edited" ? "Legacy user label" : null);
  db.close();
}

test("v4 migration preserves every user title, relation, label and review state", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "map-b-migration-")), "store.sqlite");
  await legacyDatabase(path);
  const store = new SqliteSemanticTraceStore(path);
  assert.equal(store.schemaVersion, 5);
  assert.equal((await store.getSessionTitle("fixture", "b"))?.userTitle, "Legacy user title");
  assert.equal((await store.getSemanticParent("fixture", "b"))?.userParentSessionId, "a");
  for (const verdict of ["accepted", "edited", "rejected"]) {
    const review = await store.getUserFeedback({ ...turn, nativeTurnId: verdict });
    assert.equal(review?.verdict, verdict);
    assert.equal(review?.aiOriginalText, "AI original");
    if (verdict === "edited") assert.equal(review.editedText, "Legacy user label");
  }
  assert.equal(store.overrides.list("fixture", "title").length, 1);
  assert.equal(store.overrides.list("fixture", "parent").length, 1);
  assert.equal(store.overrides.list("fixture", "label").length, 3);
  await store.close();
});

test("failed migration rolls back schema and all user data", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "map-b-rollback-")), "store.sqlite");
  await legacyDatabase(path);
  let db = new DatabaseSync(path);
  db.exec("CREATE TABLE user_edit_history (unexpected TEXT)");
  db.close();
  assert.throws(() => new SqliteSemanticTraceStore(path), /already exists/);
  db = new DatabaseSync(path);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 4);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='user_overrides'").get()!.n, 0);
  assert.equal(db.prepare("SELECT user_title FROM session_semantic_titles").get()!.user_title, "Legacy user title");
  assert.equal(db.prepare("SELECT count(*) AS n FROM turn_semantic_trace_feedback").get()!.n, 3);
  db.close();
});

test("real --no-semantic-traces server persists manual organization across restart and keeps Codex source read-only", { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "map-b-offline-"));
  const home = join(root, "codex"), storePath = join(root, "semantic.sqlite");
  await mkdir(join(home, "sessions"), { recursive: true });
  const files: [string, string][] = [];
  for (const id of ["a", "b", "c", "d"]) {
    const records = [
      { type: "session_meta", payload: { id, cwd: root, timestamp: "2026-01-01T00:00:00Z", source: "cli" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "native/1" } },
      { type: "event_msg", payload: { type: "user_message", message: `Original ${id}` } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "native/1", last_agent_message: "Fixture answer" } },
    ];
    const path = join(home, "sessions", `${id}.jsonl`), body = records.map((value) => JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", ...value })).join("\n") + "\n";
    await writeFile(path, body); files.push([path, body]);
  }
  async function start() {
    const child = spawn(process.execPath, ["apps/local-web/src/main.ts", "--port", "0", "--no-app-server", "--no-semantic-traces", "--semantic-store", storePath], { cwd: resolve(import.meta.dirname, "../../.."), env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Offline server startup timeout: ${stderr}`)); }, 10000);
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; const match = output.match(/available at (http:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolveUrl(match[1]); } });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(stderr)); });
    });
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } };
    t.after(stop);
    return { url, stop };
  }
  let running = await start();
  const request = async (path: string, body?: unknown, status = 200) => {
    const response = await fetch(running.url + path, body === undefined ? {} : { method: "POST", headers: { Origin: running.url, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const bootstrap = await request("/api/bootstrap");
  assert.equal(bootstrap.semanticTraces.generationAvailable, false);
  assert.equal(bootstrap.userOverrides.available, true);
  const workspace = bootstrap.scopes[0].id;
  const title = await request("/api/sessions/b/user-overrides/title", { value: { title: "Offline rename" }, revision: 0 });
  await request("/api/sessions/b/user-overrides/label?turnId=native%2F1", { value: { label: "Offline label" }, revision: 0 });
  await request("/api/sessions/b/user-overrides/parent", { value: { relation: "subtask", parentSessionId: "a", anchorTurnId: "native/1" }, revision: 0 });
  await request("/api/sessions/c/user-overrides/parent", { value: { relation: "continuation", parentSessionId: "a" }, revision: 0 });
  const rootEdit = await request("/api/sessions/d/user-overrides/parent", { value: { relation: "root" }, revision: 0 });
  await request("/api/sessions/b/semantic-title", {}, 503);
  await request("/api/sessions/b/user-overrides/title", { value: { title: "Stale edit" }, revision: 0 }, 409);
  await running.stop(); running = await start();
  assert.equal((await request("/api/sessions/b/user-overrides/title")).semanticTitle.displayTitle, "Offline rename");
  assert.equal((await request("/api/sessions/b/turns/native%2F1")).turn.semanticTrace.displayText, "Offline label");
  const anchoredParent = (await request("/api/sessions/b/user-overrides/parent")).semanticParent;
  assert.equal(anchoredParent.parentSessionId, "a");
  assert.equal(anchoredParent.anchorTurnId, "native/1");
  assert.equal((await request("/api/sessions/c/user-overrides/parent")).semanticParent.anchorTurnId, null);
  assert.equal((await request("/api/sessions/d/user-overrides/parent")).semanticParent.authority, "user");
  const forest = (await request(`/api/scopes/${encodeURIComponent(workspace)}/forest`)).forest;
  assert.equal(forest.roots.find((node: any) => node.sessionId === "d").placementSource, "user");
  const parentBranches = forest.branches.find((item: any) => item.sessionId === "a");
  assert.deepEqual(parentBranches.turns[0].childSessions.map((item: any) => item.childSessionId), ["b"]);
  assert.deepEqual(parentBranches.sessionLevelChildren.map((item: any) => item.childSessionId), ["c"]);
  await request(`/api/user-edits/${rootEdit.edit.id}/undo`, { revision: 1 });
  assert.equal((await request("/api/sessions/d/user-overrides/parent")).semanticParent.relation, undefined);
  await request(`/api/user-edits/${title.edit.id}/undo`, { revision: 1 });
  assert.equal((await request("/api/sessions/b/user-overrides/title")).semanticTitle.displayTitle, "Original b");
  await running.stop();
  for (const [path, body] of files) assert.equal(await readFile(path, "utf8"), body);
});
