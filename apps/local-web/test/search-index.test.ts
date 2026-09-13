import assert from "node:assert/strict";
import test from "node:test";
import type { NativeLineage, Page, Session, SessionProvider, SessionProviderCapabilities, Turn, WorkspaceScope } from "../../../packages/core/src/index.ts";
import { semanticInputFingerprint, SqliteSemanticTraceStore } from "../../../packages/semantic-store/src/index.ts";
import { WorkspaceSearchIndex } from "../src/search-index.ts";
import { createLocalWebServer } from "../src/server.ts";

const scopes: WorkspaceScope[] = [scope("workspace-a"), scope("workspace-b")];
const sessions = [session("session-a", "workspace-a", "Original normalization title"), session("session-b", "workspace-a", "接口检查"), session("session-c", "workspace-b", "Other workspace")];
const tail = `开头内容 shared-key ${"背景。".repeat(400)} tail-location-oracle`;
const turns = new Map<string, Turn[]>([
  ["session-a", [turn("session-a", "native/a1", 1, "归一化设置", tail), turn("session-a", "native/a2", 2, "pytest failed", "Mixed 混合Search works")]],
  ["session-b", [turn("session-b", "native/b1", 1, "接口超时 shared-key", "Assistant final")]],
  ["session-c", [turn("session-c", "native/c1", 1, "private workspace token", "isolation")]],
]);

test("workspace search indexes full public content, semantic fields, short Chinese, snippets and pages", async (t) => {
  const provider = new FixtureProvider();
  const semantic = new SqliteSemanticTraceStore();
  await semantic.put({ providerId: "fixture", sessionId: "session-a", nativeTurnId: "native/a2", text: "AI trace summary", inputFingerprint: semanticInputFingerprint(turns.get("session-a")![1]), generator: { id: "fixture", version: "1" }, generatedAt: "2026-01-01T00:00:00.000Z" });
  semantic.overrides.write({ providerId: "fixture", sessionId: "session-a", field: "title" }, "workspace-a", { title: "User project title" }, 0);
  semantic.overrides.write({ providerId: "fixture", sessionId: "session-a", nativeTurnId: "native/a1", field: "label" }, "workspace-a", { label: "模型校验" }, 0);
  const index = new WorkspaceSearchIndex({ provider, semantic });
  t.after(async () => { await index.close(); await semantic.close(); });
  index.start("workspace-a"); await ready(index, "workspace-a");

  assert.equal(index.status("workspace-a").indexedTurns, 3);
  assert.equal(index.query("workspace-a", "project").results[0].sourceKind, "session_title");
  assert.equal(index.query("workspace-a", "模型").mode, "substring_fallback");
  assert.equal(index.query("workspace-a", "模型").results[0].sourceKind, "turn_label");
  assert.equal(index.query("workspace-a", "trace summary").results[0].sourceKind, "turn_summary");
  assert.equal(index.query("workspace-a", "PYTEST").results[0].nativeTurnId, "native/a2");
  assert.equal(index.query("workspace-a", "混合Search").results[0].nativeTurnId, "native/a2");
  const tailHit = index.query("workspace-a", "location-oracle").results[0];
  assert.equal(tailHit.nativeTurnId, "native/a1");
  assert.ok(tailHit.highlights.length > 0, "tail hit supplies highlight offsets");
  assert.equal(index.query("workspace-a", "private workspace token").results.length, 0, "queries stay inside the current Workspace");
  assert.equal(index.query("workspace-a", "归一化", { limit: 1 }).results.length, 1);
  const first = index.query("workspace-a", "shared-key", { limit: 1 });
  assert.ok(first.nextCursor);
  assert.equal(index.query("workspace-a", "shared-key", { limit: 1, cursor: first.nextCursor }).results.length, 1);
});

test("refreshSession replaces stale documents after a user override", async (t) => {
  const provider = new FixtureProvider();
  const semantic = new SqliteSemanticTraceStore();
  const index = new WorkspaceSearchIndex({ provider, semantic });
  t.after(async () => { await index.close(); await semantic.close(); });
  index.start("workspace-a"); await ready(index, "workspace-a");
  assert.equal(index.query("workspace-a", "new-label").results.length, 0);
  semantic.overrides.write({ providerId: "fixture", sessionId: "session-a", nativeTurnId: "native/a1", field: "label" }, "workspace-a", { label: "new-label" }, 0);
  index.refreshSession("session-a");
  await eventually(() => index.query("workspace-a", "new-label").results.length === 1);
  assert.equal(index.query("workspace-a", "new-label").results[0].nativeTurnId, "native/a1");
  provider.turns.set("session-b", [{ ...provider.turns.get("session-b")![0], assistantFinal: "replacement-source-value" }]);
  index.refreshSession("session-b");
  await eventually(() => index.query("workspace-a", "replacement-source-value").results.length === 1);
  assert.equal(index.query("workspace-a", "Assistant final").results.length, 0, "stale source documents are replaced");
});

test("scoped provider updates skip unchanged Sessions, refresh changes, delete documents, and retain full fallback", async (t) => {
  const provider = new FixtureProvider();
  const index = new WorkspaceSearchIndex({ provider });
  t.after(async () => index.close());
  index.start("workspace-a"); await ready(index, "workspace-a");

  const initial = index.diagnostics();
  index.reconcileUpdate({ revision: 1, reason: "source_change", occurredAt: new Date().toISOString(), affectedSessionIds: ["session-a"] });
  await eventually(() => index.diagnostics().skippedSessions > initial.skippedSessions);

  provider.turns.set("session-a", [{ ...provider.turns.get("session-a")![0], assistantFinal: "targeted-source-change" }]);
  index.reconcileUpdate({ revision: 2, reason: "source_change", occurredAt: new Date().toISOString(), affectedSessionIds: ["session-a"] });
  await eventually(() => index.query("workspace-a", "targeted-source-change").results.length === 1);

  index.reconcileUpdate({ revision: 3, reason: "source_change", occurredAt: new Date().toISOString(), deletedSessionIds: ["session-a"] });
  assert.equal(index.query("workspace-a", "targeted-source-change").results.length, 0);
  assert.ok(index.diagnostics().removedSessions > 0);

  const fullBefore = index.diagnostics().fullReconciliations;
  index.reconcileUpdate({ revision: 4, reason: "periodic_reconciliation", occurredAt: new Date().toISOString() });
  await eventually(() => index.diagnostics().fullReconciliations > fullBefore);
});

test("scope-safe search API returns navigation payload without transcripts", async (t) => {
  const provider = new FixtureProvider();
  const index = new WorkspaceSearchIndex({ provider });
  index.start("workspace-a"); await ready(index, "workspace-a");
  const running = await createLocalWebServer({ provider, search: index, port: 0 }).start();
  t.after(async () => { await running.close(); await index.close(); });
  const response = await fetch(`${running.url}/api/scopes/workspace-a/search?q=${encodeURIComponent("location-oracle")}`);
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.results[0].nativeTurnId, "native/a1");
  assert.equal(payload.results[0].sessionId, "session-a");
  assert.equal("assistantFinal" in payload.results[0], false);
  assert.equal((await fetch(`${running.url}/api/scopes/workspace-a/search/status`)).status, 200);
});

class FixtureProvider implements SessionProvider {
  readonly sessions = sessions.map((value) => ({ ...value }));
  readonly turns = new Map([...turns].map(([sessionId, values]) => [sessionId, values.map((value) => ({ ...value }))]));
  async getCapabilities(): Promise<SessionProviderCapabilities> { return { nativeLineage: "none", openSession: false, openTurn: false, liveUpdates: false, titleRead: true, titleWrite: false, archiveRead: true }; }
  async listWorkspaceScopes(): Promise<readonly WorkspaceScope[]> { return scopes; }
  async listSessions(workspaceId: string): Promise<Page<Session>> { return { data: this.sessions.filter((item) => item.workspaceScopeId === workspaceId) }; }
  async readSession(sessionId: string): Promise<Session> { const value = this.sessions.find((item) => item.providerSessionId === sessionId); if (!value) throw new Error("missing"); return value; }
  async listTurns(sessionId: string): Promise<Page<Turn>> { return { data: this.turns.get(sessionId) ?? [] }; }
  async getNativeLineage(): Promise<NativeLineage | null> { return null; }
}

function scope(id: string): WorkspaceScope { return { id, displayName: id, canonicalRoot: `C:\\${id}`, observedRoots: [`C:\\${id}`], source: "cwd", health: { state: "complete", issues: [] } }; }
function session(id: string, workspaceScopeId: string, title: string): Session { return { providerId: "fixture", providerSessionId: id, workspaceScopeId, title, createdAt: "2026-01-01T00:00:00.000Z", archiveStatus: "active", sourceKind: "interactive", excludedFromMainWorkspaceForest: false, nativeLineageAvailability: "none", health: { state: "complete", issues: [] }, provenance: [] }; }
function turn(sessionId: string, nativeTurnId: string, displayOrdinal: number, input: string, assistantFinal: string): Turn { return { providerId: "fixture", sessionId, nativeTurnId, displayOrdinal, initiatorKind: "user", status: "completed", input: { text: input, attachments: [] }, assistantFinal, tools: [], partial: false, health: { state: "complete", issues: [] }, provenance: [] }; }
async function ready(index: WorkspaceSearchIndex, workspace: string): Promise<void> { await eventually(() => index.status(workspace).state === "ready"); }
async function eventually(check: () => boolean): Promise<void> { for (let attempt = 0; attempt < 100; attempt += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Timed out waiting for search index"); }
