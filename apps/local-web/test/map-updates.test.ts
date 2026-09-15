import assert from "node:assert/strict";
import test from "node:test";
import { patchSessionTitle } from "../map-v2/src/map-updates.ts";
import type { MapForest, SessionNodeData } from "../map-v2/src/types.ts";

test("Session title updates patch only node data and preserve topology", () => {
  const child = session("child", "Before");
  const forest: MapForest = { workspaceScopeId: "workspace", roots: [{ ...session("root", "Root"), children: [child] }], unorganized: [], stats: { sessions: 2, confirmedRoots: 1, unorganized: 0 } };
  const updated = patchSessionTitle(forest, "child", "After")!;
  assert.equal(updated.roots[0].children[0].displayTitle, "After");
  assert.equal(updated.roots[0].children[0].semanticParentSessionId, "root");
  assert.deepEqual(updated.stats, forest.stats);
});

function session(sessionId: string, displayTitle: string): SessionNodeData { return { sessionId, originalTitle: displayTitle, displayTitle, turnCount: 1, semanticRelation: sessionId === "root" ? "root" : "subtask", semanticParentSessionId: sessionId === "root" ? undefined : "root", placementSource: "user", children: [] }; }
