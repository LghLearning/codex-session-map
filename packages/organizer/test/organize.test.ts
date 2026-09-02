import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "../../core/src/index.ts";
import { organizeWorkspace, type WorkspaceOrganizationPort } from "../src/index.ts";

test("organize skips existing metadata, preserves user-owned records through the port, and is idempotent", async () => {
  const port = new FakePort([session("a"), session("b")]);
  port.titles.add("a");
  port.parents.add("b");
  const first = await organizeWorkspace({ scopeId: "workspace", port });
  assert.equal(first.titlesGenerated, 1);
  assert.equal(first.relationshipsGenerated, 1);
  assert.deepEqual(port.generatedTitles, ["b"]);
  assert.deepEqual(port.generatedParents, ["a"]);
  const second = await organizeWorkspace({ scopeId: "workspace", port });
  assert.equal(second.titlesGenerated, 0);
  assert.equal(second.relationshipsGenerated, 0);
});

test("a single Session failure is recorded and later Sessions continue", async () => {
  const port = new FakePort([session("a"), session("b")]);
  port.failTitle.add("a");
  port.failParent.add("a");
  const result = await organizeWorkspace({ scopeId: "workspace", port });
  assert.equal(result.warningDetails.length, 2);
  assert.ok(port.generatedTitles.includes("b"));
  assert.ok(port.generatedParents.includes("b"));
  assert.equal(result.phase, "completed");
});

test("cancel stops before starting another model operation", async () => {
  const controller = new AbortController();
  const port = new FakePort([session("a"), session("b"), session("c")]);
  port.afterTitle = () => controller.abort();
  const result = await organizeWorkspace({ scopeId: "workspace", port, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.deepEqual(port.generatedTitles, ["a"]);
  assert.deepEqual(port.generatedParents, []);
});

class FakePort implements WorkspaceOrganizationPort {
  readonly titles = new Set<string>();
  readonly parents = new Set<string>();
  readonly generatedTitles: string[] = [];
  readonly generatedParents: string[] = [];
  readonly failTitle = new Set<string>();
  readonly failParent = new Set<string>();
  readonly sessions: Session[];
  afterTitle?: () => void;
  constructor(sessions: Session[]) { this.sessions = sessions; }
  async listSessions() { return this.sessions; }
  async hasSemanticTitle(value: Session) { return this.titles.has(value.providerSessionId); }
  async generateSemanticTitle(value: Session) {
    if (this.failTitle.has(value.providerSessionId)) throw new Error("title failed");
    this.generatedTitles.push(value.providerSessionId);
    this.titles.add(value.providerSessionId);
    this.afterTitle?.();
  }
  async hasSemanticParent(value: Session) { return this.parents.has(value.providerSessionId); }
  async generateSemanticParent(value: Session) {
    if (this.failParent.has(value.providerSessionId)) throw new Error("parent failed");
    this.generatedParents.push(value.providerSessionId);
    this.parents.add(value.providerSessionId);
  }
}

function session(id: string): Session {
  return {
    providerId: "fixture", providerSessionId: id, workspaceScopeId: "workspace", title: id,
    archiveStatus: "active", sourceKind: "interactive", excludedFromMainWorkspaceForest: false,
    nativeLineageAvailability: "none", health: { state: "complete", issues: [] },
    provenance: [{ providerId: "fixture", tier: "primary", completeness: "complete" }],
  };
}
