import assert from "node:assert/strict";
import test from "node:test";
import { connectionToPlacement } from "../map-v2/src/placement.ts";
import { prototypeForest, prototypeTurns } from "../map-v2/src/fixture.ts";
import { buildMapGraph, sessionNodeId, turnNodeId } from "../map-v2/src/graph.ts";
import { RequestSequence, preserveInteractionState, readLastWorkspace, readWorkspaceState, resolveRestoredSelection, saveLastWorkspace, saveWorkspaceState, selectionFromUrl, updateMapUrl } from "../map-v2/src/workspace-state.ts";
import { dismissMapGuide, organizationStatusCopy, searchIndexCopy, shouldShowMapGuide, userFacingApiError } from "../map-v2/src/clarity.ts";

test("URL selection takes precedence and round-trips workspace, Session and native Turn identity", () => {
  const url = new URL("http://local/map-v2?workspace=w&session=s&turn=native%2F3&view=map");
  assert.deepEqual(selectionFromUrl(url), { kind: "turn", sessionId: "s", nativeTurnId: "native/3" });
  assert.deepEqual(resolveRestoredSelection(url, { kind: "session", sessionId: "saved" }), { kind: "turn", sessionId: "s", nativeTurnId: "native/3" });
  assert.equal(updateMapUrl(new URL("http://local/map-v2"), "scope/a", { kind: "turn", sessionId: "s 1", nativeTurnId: "native/3" }), "/map-v2?view=map&workspace=scope%2Fa&session=s+1&turn=native%2F3");
});

test("workspace state restores viewport, selection and bounded expanded Sessions", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  saveWorkspaceState(storage, "w", { expandedSessionIds: Array.from({ length: 20 }, (_, index) => `s${index}`), positions: { "session:a": { x: 9, y: 7 } }, viewport: { x: 3, y: 4, zoom: .8 }, selection: { kind: "session", sessionId: "a" }, railCollapsed: true });
  const restored = readWorkspaceState(storage, "w");
  assert.equal(restored.expandedSessionIds.length, 12);
  assert.deepEqual(restored.positions["session:a"], { x: 9, y: 7 });
  assert.deepEqual(restored.viewport, { x: 3, y: 4, zoom: .8 });
  assert.deepEqual(restored.selection, { kind: "session", sessionId: "a" });
  saveLastWorkspace(storage, "w");
  assert.equal(readLastWorkspace(storage), "w");
});

test("stale workspace requests are ignored and live reconciliation preserves interaction state and draft", () => {
  const sequence = new RequestSequence(); const first = sequence.start(); const second = sequence.start();
  assert.equal(sequence.current(first), false); assert.equal(sequence.current(second), true);
  const current = { selection: { kind: "session" as const, sessionId: "a" }, viewport: { x: 1, y: 2, zoom: .9 }, expandedSessionIds: ["a"], draft: { title: "unsaved" } };
  assert.deepEqual(preserveInteractionState(current), current);
  assert.notEqual(preserveInteractionState(current).expandedSessionIds, current.expandedSessionIds);
});

test("node drag changes positions only, while relationship targets map to Session-level or native Turn placement", () => {
  const graph = buildMapGraph({ forest: prototypeForest, expanded: new Set(["a"]), turnDirectories: prototypeTurns });
  const moved = buildMapGraph({ forest: prototypeForest, expanded: new Set(["a"]), turnDirectories: prototypeTurns, positions: { [sessionNodeId("b")]: { x: 700, y: 400 } } });
  assert.deepEqual(moved.nodes.find((node) => node.id === sessionNodeId("b"))?.position, { x: 700, y: 400 });
  assert.equal(moved.edges.find((edge) => edge.id === "semantic:b")?.source, graph.edges.find((edge) => edge.id === "semantic:b")?.source, "visual drag cannot alter placement");
  assert.deepEqual(connectionToPlacement({ source: sessionNodeId("b"), sourceHandle: "reparent", target: sessionNodeId("a"), targetHandle: "branch-in" }, graph.nodes), { childSessionId: "b", parentSessionId: "a", relation: "subtask", anchorTurnId: undefined });
  assert.deepEqual(connectionToPlacement({ source: sessionNodeId("b"), sourceHandle: "reparent", target: turnNodeId("a", "a/native-3"), targetHandle: "relation-target" }, graph.nodes), { childSessionId: "b", parentSessionId: "a", relation: "subtask", anchorTurnId: "a/native-3" });
  assert.throws(() => connectionToPlacement({ source: sessionNodeId("a"), sourceHandle: "reparent", target: turnNodeId("a", "a/native-3"), targetHandle: "relation-target" }, graph.nodes), /cannot parent itself/);
});

test("product clarity keeps first-use guidance dismissible and maps technical states to actions", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  assert.equal(shouldShowMapGuide(storage), true);
  dismissMapGuide(storage);
  assert.equal(shouldShowMapGuide(storage), false);
  assert.equal(userFacingApiError(409, "revision_conflict"), "This item changed elsewhere. Refresh and try again.");
  assert.equal(searchIndexCopy({ state: "indexing", totalSessions: 4, indexedSessions: 2, indexedTurns: 8, coverage: .5 }).label, "Preparing local search…");
  assert.match(organizationStatusCopy("interrupted"), /Continue/);
});
