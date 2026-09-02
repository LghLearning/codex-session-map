import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { CodexAdapterV1 } from "../src/adapter.ts";

test("repeated appends reconcile without duplicate sessions or native turns", async (t) => {
  const home = await fixtureHome(t);
  const adapter = new CodexAdapterV1({
    codexHome: home,
    disableAppServer: true,
    watchDebounceMs: 20,
    reconciliationIntervalMs: 2_000,
  });
  const updates: number[] = [];
  const unsubscribe = await adapter.subscribeUpdates((update) => updates.push(update.revision));
  t.after(unsubscribe);
  const rollout = join(home, "sessions", "2026", "01", "02", "rollout-modern-b.jsonl");
  await appendFile(rollout, turnLines("turn-soak-one", "2026-01-02T00:01:00.000Z"));
  await waitFor(() => updates.length >= 1);
  await appendFile(rollout, turnLines("turn-soak-two", "2026-01-02T00:02:00.000Z"));
  await waitFor(() => updates.length >= 2);
  const scopes = await adapter.listWorkspaceScopes();
  const sessions = (await Promise.all(scopes.map((scope) => allPages((cursor) => adapter.listSessions(scope.id, cursor))))).flat();
  assert.equal(sessions.filter((session) => session.providerSessionId === "session-modern").length, 1);
  const turns = await allPages((cursor) => adapter.listTurns("session-modern", cursor));
  assert.equal(turns.filter((turn) => turn.nativeTurnId === "turn-soak-one").length, 1);
  assert.equal(turns.filter((turn) => turn.nativeTurnId === "turn-soak-two").length, 1);
});

test("archive move and atomic replacement converge through reconciliation", async (t) => {
  const home = await fixtureHome(t);
  const adapter = new CodexAdapterV1({ codexHome: home, disableAppServer: true });
  await adapter.listWorkspaceScopes();
  const active = join(home, "sessions", "2025", "12", "01", "rollout-legacy.jsonl");
  const archived = join(home, "archived_sessions", "rollout-legacy.jsonl");
  await rename(active, archived);
  await adapter.refresh();
  assert.equal((await adapter.readSession("session-legacy")).archiveStatus, "archived");

  const replacement = `${archived}.replacement`;
  await writeFile(replacement, `${sessionMeta("session-legacy", "C:/Legacy")}\n${turnLines("turn-replaced", "2026-01-03T00:00:00.000Z")}`);
  await rename(archived, `${archived}.old`);
  await rename(replacement, archived);
  await adapter.refresh();
  const turns = await allPages((cursor) => adapter.listTurns("session-legacy", cursor));
  assert.deepEqual(turns.map((turn) => turn.nativeTurnId), ["turn-replaced"]);
});

test("future and missing optional fields fail soft with diagnostics", async (t) => {
  const home = await fixtureHome(t);
  const path = join(home, "sessions", "2026", "02", "01", "rollout-skew.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    sessionMeta("session-skew", "C:/Skew", { future_optional: { version: 99 } }),
    JSON.stringify({ timestamp: "2026-02-01T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-skew" } }),
    JSON.stringify({ timestamp: "2026-02-01T00:00:02.000Z", type: "future_event", payload: { optional: true } }),
    JSON.stringify({ timestamp: "2026-02-01T00:00:03.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-skew" } }),
  ].join("\n") + "\n");
  const adapter = new CodexAdapterV1({ codexHome: home, disableAppServer: true });
  await adapter.listWorkspaceScopes();
  assert.equal((await adapter.readSession("session-skew")).providerSessionId, "session-skew");
  await adapter.listTurns("session-skew");
  assert.equal(adapter.getDiagnostics().some((item) => item.code === "unknown_event"), true);
});

function turnLines(turnId: string, timestamp: string): string {
  return [
    JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({ timestamp, type: "event_msg", payload: { type: "user_message", message: "Sanitized soak fixture input." } }),
    JSON.stringify({ timestamp, type: "event_msg", payload: { type: "agent_message", message: "Sanitized soak fixture output." } }),
    JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: turnId } }),
  ].join("\n") + "\n";
}

function sessionMeta(id: string, cwd: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id, cwd, source: "cli", ...extra } });
}

async function fixtureHome(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-map-soak-"));
  await cp(new URL("../../../tests/fixtures/codex-home/", import.meta.url), root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
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

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reconciled snapshot");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
