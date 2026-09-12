import assert from "node:assert/strict";
import test from "node:test";
import type { Turn } from "../../core/src/index.ts";
import { SqliteSemanticTraceStore, TurnSemanticTraceService } from "../src/index.ts";

test("a canceled late Trace result is rejected before semantic storage commit", async () => {
  const store = new SqliteSemanticTraceStore();
  let mayCommit = true;
  const service = new TurnSemanticTraceService({
    store,
    generator: { identity: { id: "fixture", version: "1" }, generate: async () => ({ text: "late result" }) },
  });
  mayCommit = false;
  await assert.rejects(service.ensure(turn(), { mayCommit: () => mayCommit }), (error: any) => error?.name === "AbortError");
  assert.equal(await store.get({ providerId: "fixture", sessionId: "session", nativeTurnId: "turn" }), undefined);
  await store.close();
});

function turn(): Turn {
  return { providerId: "fixture", sessionId: "session", nativeTurnId: "turn", displayOrdinal: 1, initiatorKind: "user", status: "completed", input: { text: "input", format: "plain" }, assistantFinal: "answer", tools: [], provenance: [] };
}
