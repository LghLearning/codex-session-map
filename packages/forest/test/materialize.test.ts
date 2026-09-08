import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "../../core/src/index.ts";
import { materializeSessionForest, projectSessionBranches, type BranchTurn, type ForestSessionInput } from "../src/index.ts";

test("forest includes every Session, supports multiple roots, and applies title/parent authority", () => {
  const inputs: ForestSessionInput[] = [
    input("a", { semanticTitle: { generatedTitle: "AI A", userTitle: "User A" }, turnCount: 3, traceCount: 2 }),
    input("b", { semanticParent: { generatedRelation: "continuation", generatedParentSessionId: "a" } }),
    input("c", { semanticParent: { generatedRelation: "subtask", generatedParentSessionId: "a", userRelation: "root" } }),
    input("d"),
  ];
  const forest = materializeSessionForest("workspace", inputs);
  assert.equal(forest.stats.sessions, 4);
  assert.equal(forest.stats.confirmedRoots, 1);
  assert.equal(forest.stats.unorganized, 2);
  assert.equal(forest.stats.semanticEdges, 1);
  assert.equal(forest.stats.userCorrected, 1);
  assert.equal(forest.stats.missingTitles, 3);
  assert.equal(forest.stats.missingTraces, 1);
  assert.deepEqual(forest.roots.map((node) => node.sessionId), ["c"]);
  assert.deepEqual(forest.unorganized.map((node) => node.sessionId), ["a", "d"]);
  assert.equal(forest.unorganized[0]?.displayTitle, "User A");
  assert.equal(forest.unorganized[0]?.children[0]?.sessionId, "b");
  assert.equal(forest.roots[0]?.placementSource, "user");
});

test("missing semantic data and invalid parents remain reachable as Unorganized", () => {
  const forest = materializeSessionForest("workspace", [
    input("plain"),
    input("orphan", { semanticParent: { generatedRelation: "continuation", generatedParentSessionId: "missing" } }),
  ]);
  assert.equal(forest.roots.length, 0);
  assert.equal(forest.unorganized.length, 2);
  assert.equal(forest.unorganized.find((node) => node.sessionId === "plain")?.displayTitle, "Original plain");
  assert.deepEqual(forest.issues, [{ code: "missing_parent", sessionId: "orphan", parentSessionId: "missing" }]);
});

test("cycle-safe projection breaks corrupt semantic cycles without changing native lineage", () => {
  const native = { providerId: "fixture", sessionId: "a", parentSessionId: "native", kind: "user_fork" as const, recovery: "session_only" as const };
  const forest = materializeSessionForest("workspace", [
    input("a", { semanticParent: { generatedRelation: "continuation", generatedParentSessionId: "b" }, nativeLineage: native }),
    input("b", { semanticParent: { generatedRelation: "continuation", generatedParentSessionId: "a" } }),
  ]);
  assert.equal(forest.stats.sessions, 2);
  assert.equal(forest.stats.confirmedRoots, 0);
  assert.equal(forest.stats.unorganized, 1);
  assert.equal(forest.issues[0]?.code, "cycle_broken");
  assert.deepEqual(find([...forest.roots, ...forest.unorganized], "a")?.nativeLineage, native);
});

test("branch projection keeps Turn order, supports shared anchors, missing anchors, and native/semantic separation", () => {
  const inputs: ForestSessionInput[] = [
    input("a"), input("c"),
    input("b", {
      semanticParent: { userRelation: "subtask", userParentSessionId: "c", userAnchorTurnId: "c/t7" },
      nativeLineage: { providerId: "fixture", sessionId: "b", parentSessionId: "a", originTurnId: "a/t3", kind: "user_fork", recovery: "exact" },
    }),
    input("d", { semanticParent: { userRelation: "continuation", userParentSessionId: "a", userAnchorTurnId: "a/t3" } }),
    input("e", { semanticParent: { userRelation: "subtask", userParentSessionId: "a", userAnchorTurnId: "missing" } }),
    input("f", { semanticParent: { userRelation: "continuation", userParentSessionId: "a" } }),
  ];
  const turns = new Map<string, readonly BranchTurn[]>([
    ["a", [{ nativeTurnId: "a/t1", displayOrdinal: 1, displayLabel: "A1" }, { nativeTurnId: "a/t3", displayOrdinal: 3, displayLabel: "A3" }]],
    ["c", [{ nativeTurnId: "c/t7", displayOrdinal: 7, displayLabel: "C7" }]],
  ]);
  const projected = projectSessionBranches(inputs, turns);
  const a = projected.find((item) => item.sessionId === "a")!;
  const c = projected.find((item) => item.sessionId === "c")!;
  assert.deepEqual(a.turns.map((item) => item.nativeTurnId), ["a/t1", "a/t3"]);
  assert.deepEqual(a.turns[1].childSessions.map((item) => [item.childSessionId, item.source]), [["b", "native"], ["d", "user"]]);
  assert.deepEqual(a.sessionLevelChildren.map((item) => item.childSessionId), ["f"]);
  assert.deepEqual(a.unavailableAnchors.map((item) => item.childSessionId), ["e"]);
  assert.deepEqual(c.turns[0].childSessions.map((item) => [item.childSessionId, item.source]), [["b", "user"]]);
});

function input(id: string, overrides: Partial<ForestSessionInput> = {}): ForestSessionInput {
  return {
    session: session(id),
    turnCount: 0,
    traceCount: 0,
    ...overrides,
  };
}

function session(id: string): Session {
  return {
    providerId: "fixture", providerSessionId: id, workspaceScopeId: "workspace", title: `Original ${id}`,
    createdAt: `2026-08-0${id.charCodeAt(0) % 8 + 1}T00:00:00.000Z`, archiveStatus: "active", sourceKind: "interactive",
    excludedFromMainWorkspaceForest: false, nativeLineageAvailability: "none",
    health: { state: "complete", issues: [] }, provenance: [{ providerId: "fixture", tier: "primary", completeness: "complete" }],
  };
}

function find(nodes: readonly any[], id: string): any {
  for (const node of nodes) {
    if (node.sessionId === id) return node;
    const child = find(node.children, id);
    if (child) return child;
  }
}
