import type { OrganizationStatus } from "./api.ts";
import type { SearchIndexStatus } from "./types.ts";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const FIRST_USE_NOTICE_KEY = "codex-session-map:map-guide-dismissed";

export function shouldShowMapGuide(storage: StorageLike): boolean {
  return storage.getItem(FIRST_USE_NOTICE_KEY) !== "1";
}

export function dismissMapGuide(storage: StorageLike): void {
  storage.setItem(FIRST_USE_NOTICE_KEY, "1");
}

export function userFacingApiError(status: number, message?: string): string {
  if (status === 409) return "This item changed elsewhere. Refresh and try again.";
  return message ?? `Request failed (${status})`;
}

export function searchIndexCopy(index: SearchIndexStatus): { label: string; detail?: string } {
  if (index.state === "error") return { label: "Search unavailable", detail: "The map and reader remain available." };
  if (index.state === "indexing" || index.state === "idle") return { label: "Preparing local search…", detail: "Existing results remain available while verification completes." };
  if (index.freshness === "unverified") return { label: `${index.indexedTurns} Turns indexed`, detail: "Checking that search is current; results remain available." };
  if (index.freshness === "stale") return { label: `${index.indexedTurns} Turns indexed`, detail: "Search results may be out of date while the index refreshes." };
  return { label: `${index.indexedTurns} Turns indexed` };
}

export function organizationStatusCopy(status: OrganizationStatus): string {
  return ({
    queued: "Preparing organization…",
    running: "Organizing…",
    pausing: "Finishing the current item before pausing…",
    paused: "Organization paused · Continue when ready",
    canceling: "Canceling after the current item…",
    canceled: "Organization canceled",
    completed: "Organization complete",
    completed_with_failures: "Complete with some failures · Retry available",
    interrupted: "Organization interrupted · Continue when ready",
    failed: "Organization failed · Retry available",
  } as Record<OrganizationStatus, string>)[status];
}
