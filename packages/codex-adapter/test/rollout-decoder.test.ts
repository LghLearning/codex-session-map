import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DiagnosticCollector } from "../src/diagnostics.ts";
import { decodeRollout } from "../src/rollout-source.ts";

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
