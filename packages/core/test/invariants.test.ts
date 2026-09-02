import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { NativeLineage, Session, Turn, WorkspaceScope } from "../src/index.ts";

test("Core source does not depend on Codex storage schema", async () => {
  const root = new URL("../src/", import.meta.url);
  const files = await readdir(root);
  const text = (await Promise.all(files.filter((name) => name.endsWith(".ts")).map((name) => readFile(new URL(name, root), "utf8")))).join("\n");
  for (const forbidden of ["rollout_path", "state_5.sqlite", "thread_history", "session_index", "codex://"]) assert.equal(text.includes(forbidden), false, forbidden);
});

test("Core identities and health remain provider-neutral", () => {
  const scope: WorkspaceScope = { id: "scope", displayName: "Scope", observedRoots: [], source: "ambiguous", health: { state: "partial", issues: ["missing"] } };
  const session: Session = {
    providerId: "example",
    providerSessionId: "opaque-session",
    workspaceScopeId: scope.id,
    title: "Session",
    archiveStatus: "unknown",
    sourceKind: "unknown",
    excludedFromMainWorkspaceForest: false,
    nativeLineageAvailability: "none",
    health: { state: "broken", issues: ["upstream_missing"] },
    provenance: [],
  };
  const turn: Turn = {
    providerId: "example",
    sessionId: session.providerSessionId,
    nativeTurnId: "opaque-native-turn",
    displayOrdinal: 99,
    initiatorKind: "user",
    status: "partial",
    input: { attachments: [] },
    tools: [],
    partial: true,
    health: { state: "partial", issues: [] },
    provenance: [],
  };
  const lineage: NativeLineage = { providerId: "example", sessionId: session.providerSessionId, parentSessionId: "parent", kind: "history_base", recovery: "session_only" };
  assert.equal(turn.nativeTurnId, "opaque-native-turn");
  assert.equal(turn.displayOrdinal, 99);
  assert.equal(Object.hasOwn(lineage, "semanticParent"), false);
  assert.equal(Object.hasOwn(session, "providerMetadata"), false);
});
