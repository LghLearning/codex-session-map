import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { RolloutSourceRegistry, type RolloutRegistryFileInput } from "../src/rollout-registry.ts";

test("rollout registry is rebuildable metadata, preserves relocation identity, and commits multi-file updates atomically", async () => {
  const databasePath = join(await mkdtemp(join(tmpdir(), "codex-rollout-registry-")), "source-registry.sqlite");
  const registry = new RolloutSourceRegistry(databasePath);
  const first = file("file:v1:first", "C:\\Codex\\sessions\\first.jsonl", [
    { sessionId: "session-a", stableSegmentIdentity: "segment:v2:a", segmentOrder: 0 },
    { sessionId: "session-b", stableSegmentIdentity: "segment:v2:b", segmentOrder: 0 },
  ]);
  const second = file("file:v1:second", "C:\\Codex\\sessions\\second.jsonl", [{ sessionId: "session-a", stableSegmentIdentity: "segment:v2:c", segmentOrder: 1 }]);
  registry.reconcile([first, second]);
  assert.equal(registry.snapshot().length, 2);
  assert.deepEqual(registry.snapshot()[0]?.sessions.map((session) => session.sessionId), ["session-a", "session-b"]);

  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  const columns = inspection.prepare("PRAGMA table_info(rollout_files)").all() as { name: string }[];
  inspection.close();
  assert.equal(columns.some((column) => /record|body|partial_tail/i.test(column.name)), false, "registry must not retain decoded history or a redundant partial-tail field");

  const relocated = { ...first, canonicalPath: "C:\\Codex\\archived_sessions\\first.jsonl" };
  registry.reconcile([relocated, second]);
  const afterRelocation = registry.snapshot();
  assert.equal(afterRelocation.find((row) => row.registryFileId === first.registryFileId)?.canonicalPath, relocated.canonicalPath);

  const beforeFailedUpdate = JSON.stringify(afterRelocation);
  const invalid = { ...second, rootKind: "invalid" as "active" };
  assert.throws(() => registry.reconcile([relocated, invalid]));
  assert.equal(JSON.stringify(registry.snapshot()), beforeFailedUpdate, "a failed registry update must expose the prior complete snapshot");

  registry.reconcile([relocated]);
  assert.equal(registry.snapshot().length, 1, "deleting a source is represented by rebuilding the derived snapshot");
});

function file(registryFileId: string, canonicalPath: string, sessions: RolloutRegistryFileInput["sessions"]): RolloutRegistryFileInput {
  return {
    registryFileId,
    canonicalPath,
    rootKind: "active",
    stableFileIdentity: registryFileId,
    size: 128,
    mtimeMs: 100,
    sourceStamp: `stamp:${registryFileId}`,
    checkpoint: {
      decoderVersion: 2,
      observedEof: 128,
      committedOffset: 128,
      physicalLineCount: 4,
      headHash: "head",
      tailOffset: 0,
      tailHash: "tail",
      identityPrefixHash: "prefix",
    },
    sessions,
  };
}
