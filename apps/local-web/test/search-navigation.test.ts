import assert from "node:assert/strict";
import test from "node:test";
import { resolveSearchNavigation } from "../map-v2/src/search/navigation.ts";

test("Turn result targets native identity and expands only its Session", () => {
  const result = { sessionId: "session-a", nativeTurnId: "native/t7", displayOrdinal: 7, sessionTitle: "A", sourceKind: "assistant_final" as const, snippet: "hit", highlights: [] };
  const navigation = resolveSearchNavigation(result, new Set(["old-a", "old-b"]), 2);
  assert.deepEqual(navigation.selection, { kind: "turn", sessionId: "session-a", nativeTurnId: "native/t7" });
  assert.deepEqual([...navigation.expanded], ["old-b", "session-a"]);
  assert.equal(navigation.nodeId, "turn:session-a:native/t7");
});

test("Session result preserves expansion and targets the Session node", () => {
  const result = { sessionId: "session-a", sessionTitle: "A", sourceKind: "session_title" as const, snippet: "A", highlights: [] };
  const navigation = resolveSearchNavigation(result, new Set(["expanded"]), 2);
  assert.deepEqual(navigation.selection, { kind: "session", sessionId: "session-a" });
  assert.deepEqual([...navigation.expanded], ["expanded"]);
  assert.equal(navigation.nodeId, "session:session-a");
});
