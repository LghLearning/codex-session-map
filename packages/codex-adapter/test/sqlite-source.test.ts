import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CodexAdapterV1 } from "../src/adapter.ts";

test("structured fallback recovers a session and native turn without rollouts", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-map-sqlite-"));
  await mkdir(join(home, "sessions"));
  await mkdir(join(home, "archived_sessions"));
  const missingRollout = join(home, "sessions", "missing.jsonl");
  const state = new DatabaseSync(join(home, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT, title TEXT, archived INTEGER, history_mode TEXT, project_id TEXT)");
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("sqlite-session", missingRollout, 1_700_000_000, 1_700_000_010, "cli", "C:\\Structured", "Structured", 0, "paginated", null);
  state.close();

  const history = new DatabaseSync(join(home, "thread_history_1.sqlite"));
  history.exec("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, error_json TEXT, started_at INTEGER, completed_at INTEGER)");
  history.exec("CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, item_json TEXT)");
  history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)").run("sqlite-session", "native-sqlite-turn", 7, "failed", "{\"message\":\"synthetic\"}", 1_700_000_001, 1_700_000_002);
  history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)").run("sqlite-session", "native-sqlite-turn", "item-1", 8, JSON.stringify({ type: "userMessage", content: [{ type: "inputText", text: "Synthetic" }] }));
  history.close();

  const statePath = join(home, "state_5.sqlite");
  const historyPath = join(home, "thread_history_1.sqlite");
  const before = [await digest(statePath), await digest(historyPath)];

  const adapter = new CodexAdapterV1({ codexHome: home, disableAppServer: true });
  const scopes = await adapter.listWorkspaceScopes();
  const sessionPage = await adapter.listSessions(scopes[0]!.id);
  assert.equal(sessionPage.data[0]?.providerSessionId, "sqlite-session");
  const turns = await adapter.listTurns("sqlite-session");
  assert.equal(turns.data[0]?.nativeTurnId, "native-sqlite-turn");
  assert.equal(turns.data[0]?.displayOrdinal, 7);
  assert.equal(turns.data[0]?.status, "failed");
  assert.equal(adapter.getDiagnostics().some((item) => item.code === "missing_rollout"), true);
  assert.deepEqual([await digest(statePath), await digest(historyPath)], before, "read-only queries must not mutate either upstream database");
});

test("structured fields override rollout reconciliation without losing segment provenance", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-map-precedence-"));
  const sessions = join(home, "sessions");
  await mkdir(sessions);
  await mkdir(join(home, "archived_sessions"));
  const rollout = join(sessions, "rollout.jsonl");
  await writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: "precedence-session", cwd: "C:\\Fallback", source: "cli" } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "Rollout-derived title" } }),
    "",
  ].join("\n"));
  const state = new DatabaseSync(join(home, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT, title TEXT, archived INTEGER, history_mode TEXT, project_id TEXT)");
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("precedence-session", rollout, 1_700_000_000, 1_700_000_010, "cli", "C:\\Structured", "Structured title", 0, "legacy", null);
  state.close();

  const adapter = new CodexAdapterV1({ codexHome: home, disableAppServer: true });
  const session = await adapter.readSession("precedence-session");
  assert.equal(session.title, "Structured title");
  assert.equal(session.provenance[0]?.tier, "structured_fallback");
  assert.equal(session.provenance.some((item) => item.tier === "reconciliation" && item.physicalRecordCount === 1), true);
});

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
