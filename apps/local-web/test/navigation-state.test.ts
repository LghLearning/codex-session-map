import assert from "node:assert/strict";
import test from "node:test";
import { buildNavigationPath, parseNavigationPath, resolveNavigationAvailability } from "../public/navigation-state.js";

test("navigation URLs round-trip opaque workspace, session and turn identities", () => {
  const target = { scopeId: "provider-project:scope/a", sessionId: "session 1", turnId: "turn/opaque" };
  const path = buildNavigationPath(target);
  assert.equal(path, "/workspaces/provider-project%3Ascope%2Fa/sessions/session%201/turns/turn%2Fopaque");
  assert.deepEqual(parseNavigationPath(path), { target });
});

test("invalid and missing navigation targets degrade to the nearest valid level", () => {
  assert.equal(parseNavigationPath("/workspaces/scope/unexpected/path").issue, "invalid_route");
  assert.deepEqual(
    resolveNavigationAvailability(
      { scopeId: "missing", sessionId: "session-a", turnId: "turn-a" },
      { scopeIds: ["scope-a"], sessionIds: ["session-a"], turnIds: ["turn-a"] },
    ),
    { target: { scopeId: "scope-a" }, issue: "workspace_missing" },
  );
  assert.deepEqual(
    resolveNavigationAvailability(
      { scopeId: "scope-a", sessionId: "missing", turnId: "turn-a" },
      { scopeIds: ["scope-a"], sessionIds: ["session-a"], turnIds: ["turn-a"] },
    ),
    { target: { scopeId: "scope-a" }, issue: "session_missing" },
  );
  assert.deepEqual(
    resolveNavigationAvailability(
      { scopeId: "scope-a", sessionId: "session-a", turnId: "missing" },
      { scopeIds: ["scope-a"], sessionIds: ["session-a"], turnIds: ["turn-a"] },
    ),
    { target: { scopeId: "scope-a", sessionId: "session-a" }, issue: "turn_missing" },
  );
});
