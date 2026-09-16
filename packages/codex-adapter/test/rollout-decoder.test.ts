import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DiagnosticCollector } from "../src/diagnostics.ts";
import { decodeRollout, RolloutCodexSource } from "../src/rollout-source.ts";

test("decoder checkpoints only newline-committed records and resumes an append", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-map-decoder-"));
  const path = join(root, "rollout.jsonl");
  await writeFile(path, '{"type":"one"}\n{"type":"two"}');
  const diagnostics = new DiagnosticCollector();
  const first = await decodeRollout(path, undefined, diagnostics);
  assert.equal(first.records.length, 1);
  assert.equal(first.partialTail, true);
  assert.equal(diagnostics.snapshot().some((item) => item.code === "partial_line"), true);

  await appendFile(path, "\n");
  const second = await decodeRollout(path, first.checkpoint, diagnostics);
  assert.equal(second.mode, "append");
  assert.deepEqual(second.records.map((record) => [record.ordinal, record.value.type]), [[2, "two"]]);
});

test("rollout refresh decodes only the hinted append and atomically reprojects a rewrite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-map-incremental-"));
  await cp(new URL("../../../tests/fixtures/codex-home/", import.meta.url), root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sessions", "2026", "01", "01", "rollout-modern-a.jsonl");
  const source = new RolloutCodexSource({ codexHome: root, diagnostics: new DiagnosticCollector() });
  const initial = await source.list();
  assert.equal(initial.threads.some((thread) => thread.id === "session-modern"), true);

  await appendFile(path, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "incremental-turn" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "incremental" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "incremental-turn" } }),
  ].join("\n") + "\n");
  const appended = await source.refresh([path]);
  assert.equal(appended.changed, true);
  assert.equal(appended.stats.filesDecodedAppend, 1);
  assert.equal(appended.stats.filesDecodedFull, 0);
  assert.deepEqual(appended.stats.affectedPaths, [path]);
  assert.equal(appended.snapshot.threads.find((thread) => thread.id === "session-modern")?.physicalSegmentCount, 2);

  const noop = await source.refresh([]);
  assert.equal(noop.changed, false);
  assert.equal(noop.stats.filesDecodedAppend, 0);
  assert.equal(noop.stats.filesDecodedFull, 0);

  await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: "session-modern", cwd: "C:/Work/Project" } }) + "\n");
  const rewritten = await source.refresh([path]);
  assert.equal(rewritten.stats.filesDecodedFull, 1);
  assert.equal(rewritten.stats.filesDecodedAppend, 0);
  assert.equal(rewritten.snapshot.threads.find((thread) => thread.id === "session-modern")?.physicalSegmentCount, 2);
});
