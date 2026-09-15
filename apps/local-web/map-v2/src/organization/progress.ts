import type { OrganizationJobView } from "../api.ts";

export const ORGANIZATION_POLL_FALLBACK_MS = 8_000;

export function acceptsOrganizationProgress(current: OrganizationJobView | undefined, incoming: OrganizationJobView, workspaceId: string): boolean {
  if (incoming.workspaceId !== workspaceId) return false;
  if (!current) return true;
  if (incoming.id === current.id) return incoming.revision > current.revision;
  return Date.parse(incoming.createdAt) >= Date.parse(current.createdAt) && !["queued", "running", "pausing", "canceling"].includes(current.status);
}
