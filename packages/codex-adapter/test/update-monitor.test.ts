import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexUpdateMonitor, resolveWatchPath, type SourceInvalidationReason } from "../src/update-monitor.ts";

test("watch path resolution canonicalizes Windows paths and preserves fallbacks", () => {
  assert.equal(resolveWatchPath("C:\\Users\\USER~1\\AppData\\Local\\Temp", "win32", () => "C:\\Users\\User\\AppData\\Local\\Temp"), "C:\\Users\\User\\AppData\\Local\\Temp");
  assert.equal(resolveWatchPath("C:\\watch-root", "win32", () => { throw new Error("unavailable"); }), "C:\\watch-root");
  assert.equal(resolveWatchPath("/tmp/watch-root", "linux", () => { throw new Error("must not resolve"); }), "/tmp/watch-root");
});

test("filesystem hints are debounced and periodic reconciliation remains a fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-session-map-monitor-"));
  const sessions = join(root, "sessions");
  const archived = join(root, "archived_sessions");
  await mkdir(join(sessions, "2026", "01", "01"), { recursive: true });
  await mkdir(archived, { recursive: true });
  const rollout = join(sessions, "2026", "01", "01", "rollout.jsonl");
  const state = join(root, "state_5.sqlite");
  const history = join(root, "thread_history_1.sqlite");
  await Promise.all([writeFile(rollout, ""), writeFile(state, ""), writeFile(history, "")]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const reasons: SourceInvalidationReason[] = [];
  const monitor = new CodexUpdateMonitor({
    sessionsDirectory: sessions,
    archivedSessionsDirectory: archived,
    stateDatabase: state,
    historyDatabase: history,
    debounceMs: 20,
    reconciliationIntervalMs: 100,
    onInvalidate: (reason) => { reasons.push(reason); },
  });
  monitor.start();
  t.after(() => monitor.close());

  await appendFile(rollout, "{}\n");
  await waitFor(() => reasons.includes("source_change"), 2_000);
  await waitFor(() => reasons.includes("periodic_reconciliation"), 2_000);
  assert.ok(reasons.length >= 2);
});

test("periodic reconciliation restores correctness when watcher hints are unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-session-map-missed-watch-"));
  const sessions = join(root, "sessions");
  const archived = join(root, "archived_sessions");
  await Promise.all([mkdir(sessions, { recursive: true }), mkdir(archived, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const reasons: SourceInvalidationReason[] = [];
  const monitor = new CodexUpdateMonitor({
    sessionsDirectory: sessions,
    archivedSessionsDirectory: archived,
    disableFilesystemWatch: true,
    reconciliationIntervalMs: 60,
    onInvalidate: (reason) => { reasons.push(reason); },
  });
  monitor.start();
  t.after(() => monitor.close());
  await writeFile(join(sessions, "unobserved.jsonl"), "{}\n");
  await waitFor(() => reasons.includes("periodic_reconciliation"), 2_000);
  assert.deepEqual(new Set(reasons), new Set(["periodic_reconciliation"]));
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for update monitor event");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
