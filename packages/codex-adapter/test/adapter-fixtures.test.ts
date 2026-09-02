import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CodexAdapterV1 } from "../src/adapter.ts";

test("rollout fallback satisfies C1 session, segment, turn, archive and hidden-agent gates", async () => {
  const home = await fixtureHome();
  const adapter = new CodexAdapterV1({ codexHome: home, disableAppServer: true, pageSize: 2 });
  const scopes = await adapter.listWorkspaceScopes();
  const sessions = (await Promise.all(scopes.map((scope) => allPages((cursor) => adapter.listSessions(scope.id, cursor))))).flat();

  const modernMatches = sessions.filter((session) => session.providerSessionId === "session-modern");
  assert.equal(modernMatches.length, 1, "multiple physical segments must become one session");
  assert.equal(modernMatches[0]?.provenance.find((item) => item.tier === "reconciliation")?.physicalRecordCount, 2);

  const turns = await allPages((cursor) => adapter.listTurns("session-modern", cursor));
  assert.deepEqual(turns.map((turn) => turn.nativeTurnId), ["turn-completed", "turn-interrupted", "turn-failed", "turn-second-segment"]);
  assert.deepEqual(turns.map((turn) => turn.status), ["completed", "interrupted", "failed", "completed"]);
  assert.equal(turns[0]?.tools[0]?.callId, "call-1");
  assert.equal(turns[0]?.tools[0]?.status, "completed");
  const legacyTurns = await allPages((cursor) => adapter.listTurns("session-legacy", cursor));
  assert.equal(legacyTurns.length, 2, "legacy user messages must establish deterministic recovered boundaries");
  assert.equal(legacyTurns.every((turn) => turn.nativeTurnId.startsWith("recovered:")), true);

  assert.equal(sessions.some((session) => session.providerSessionId === "session-archived" && session.archiveStatus === "archived"), true);
  assert.equal(sessions.some((session) => session.providerSessionId === "session-subagent"), false, "hidden agents stay out of the default forest");
  assert.equal((await adapter.readSession("session-subagent")).excludedFromMainWorkspaceForest, true);
  assert.deepEqual(await adapter.getNativeLineage("session-subagent"), {
    providerId: "codex",
    sessionId: "session-subagent",
    parentSessionId: "session-modern",
    kind: "subagent_spawn",
    recovery: "session_only",
  });
  assert.equal((await adapter.readSession("session-cwd-change")).workspaceScopeId, "ambiguous");
  assert.equal(adapter.getDiagnostics().some((item) => item.code === "multi_segment_session" && item.sessionId === "session-modern"), true);
  assert.equal(adapter.getDiagnostics().some((item) => item.code === "partial_line"), true);
  assert.equal(adapter.getDiagnostics().some((item) => item.code === "unknown_event"), true);
});

test("hidden agent sessions remain enumerable in diagnostics mode", async () => {
  const adapter = new CodexAdapterV1({ codexHome: await fixtureHome(), disableAppServer: true, includeHidden: true });
  const scopes = await adapter.listWorkspaceScopes();
  const sessions = (await Promise.all(scopes.map((scope) => allPages((cursor) => adapter.listSessions(scope.id, cursor))))).flat();
  assert.equal(sessions.some((session) => session.providerSessionId === "session-subagent" && session.excludedFromMainWorkspaceForest), true);
});

async function fixtureHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-map-fixture-"));
  const source = new URL("../../../tests/fixtures/codex-home/", import.meta.url);
  await cp(source, root, { recursive: true });
  const fragment = (await readFile(new URL("../../../tests/fixtures/partial-tail.fragment", import.meta.url), "utf8")).trimEnd();
  const target = join(root, "sessions", "2026", "01", "06");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "rollout-partial.jsonl"), fragment);
  return root;
}

async function allPages<T>(load: (cursor?: string) => Promise<{ data: readonly T[]; nextCursor?: string }>): Promise<T[]> {
  const values: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    values.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}
