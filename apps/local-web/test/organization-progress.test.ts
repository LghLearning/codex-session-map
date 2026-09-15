import assert from "node:assert/strict";
import test from "node:test";
import { acceptsOrganizationProgress, ORGANIZATION_POLL_FALLBACK_MS } from "../map-v2/src/organization/progress.ts";
import type { OrganizationJobView } from "../map-v2/src/api.ts";

test("organization progress accepts increasing revisions and rejects stale, cross-Workspace, and unrelated Job events", () => {
  const current = job("job-a", "workspace-a", 4, "running");
  assert.equal(acceptsOrganizationProgress(current, job("job-a", "workspace-a", 5, "running"), "workspace-a"), true);
  assert.equal(acceptsOrganizationProgress(current, job("job-a", "workspace-a", 4, "running"), "workspace-a"), false);
  assert.equal(acceptsOrganizationProgress(current, job("job-a", "workspace-b", 5, "running"), "workspace-a"), false);
  assert.equal(acceptsOrganizationProgress(current, job("job-b", "workspace-a", 1, "running"), "workspace-a"), false);
  assert.ok(ORGANIZATION_POLL_FALLBACK_MS >= 5_000);
});

function job(id: string, workspaceId: string, revision: number, status: OrganizationJobView["status"]): OrganizationJobView { return { id, workspaceId, revision, mode: "quick", status, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", counts: { planned: 0, queued: 0, running: 0, generated: 0, reused: 0, failed: 0, canceled: 0, stale: 0, byOperation: { trace: counts(), title: counts(), parent: counts() } } }; }
function counts() { return { planned: 0, completed: 0, generated: 0, reused: 0, failed: 0 }; }
