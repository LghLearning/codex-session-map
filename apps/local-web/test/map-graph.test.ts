import assert from "node:assert/strict";
import test from "node:test";
import { buildMapGraph, sessionNodeId, turnNodeId } from "../map-v2/src/graph.ts";
import { prototypeForest, prototypeTurns } from "../map-v2/src/fixture.ts";

test("prototype map renders multiple roots, ordered Turn chains and distinct anchored/session-level/native branches", () => {
  const collapsed = buildMapGraph({ forest: prototypeForest, expanded: new Set(), turnDirectories: prototypeTurns });
  assert.equal(collapsed.nodes.filter((node) => node.type === "session").length, 15);
  assert.equal(collapsed.nodes.filter((node) => node.type === "turn").length, 0);
  assert.equal(prototypeForest.roots.length, 4);
  assert.equal(prototypeForest.unorganized.length, 3);

  const expanded = buildMapGraph({ forest: prototypeForest, expanded: new Set(["a", "g"]), turnDirectories: prototypeTurns, showNative: true });
  assert.equal(expanded.nodes.filter((node) => node.type === "turn").length, 22);
  const aTurns = expanded.nodes.filter((node) => node.type === "turn" && (node.data as any).sessionId === "a");
  assert.deepEqual(aTurns.map((node) => (node.data as any).turn.displayOrdinal), Array.from({ length: 12 }, (_, index) => index + 1));
  const anchorSource = turnNodeId("a", "a/native-3");
  assert.deepEqual(expanded.edges.filter((edge) => edge.className?.includes("semantic-edge") && edge.source === anchorSource).map((edge) => edge.target).sort(), [sessionNodeId("b"), sessionNodeId("c")]);
  assert.ok(expanded.edges.some((edge) => edge.className === "turn-chain-edge" && edge.source === anchorSource && edge.target === turnNodeId("a", "a/native-4")), "A mainline continues from T3 to T4");
  assert.ok(expanded.edges.some((edge) => edge.target === sessionNodeId("s") && edge.source === sessionNodeId("a")), "Session-level child uses its parent Session");
  assert.ok(expanded.edges.some((edge) => edge.id === "native:x" && edge.source === anchorSource));
  assert.ok(expanded.edges.some((edge) => edge.id === "semantic:x" && edge.source === turnNodeId("g", "g/native-7")));
});

test("prototype layout gives every root a non-overlapping vertical region and manual positions override layout only", () => {
  const expandedIds = new Set(["a", "g"]);
  const graph = buildMapGraph({ forest: prototypeForest, expanded: expandedIds, turnDirectories: prototypeTurns });
  const rootNodes = prototypeForest.roots.map((root) => graph.nodes.find((node) => node.id === sessionNodeId(root.sessionId))!);
  for (let index = 1; index < rootNodes.length; index += 1) assert.ok(rootNodes[index].position.y > rootNodes[index - 1].position.y);
  const moved = buildMapGraph({ forest: prototypeForest, expanded: expandedIds, turnDirectories: prototypeTurns, positions: { [sessionNodeId("b")]: { x: 999, y: 777 } } });
  assert.deepEqual(moved.nodes.find((node) => node.id === sessionNodeId("b"))?.position, { x: 999, y: 777 });
  assert.equal(moved.edges.find((edge) => edge.id === "semantic:b")?.source, turnNodeId("a", "a/native-3"));
});
