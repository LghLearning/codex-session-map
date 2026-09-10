import type { MapForest, Relation, SearchIndexStatus, SearchPage, TurnDirectoryItem } from "./types.ts";

export interface Bootstrap {
  scopes: { id: string; displayName: string }[];
  capabilities: { liveUpdates?: boolean };
  semanticTraces?: { available: boolean; generationAvailable: boolean };
  semanticTitles?: { available: boolean; generationAvailable: boolean };
  semanticParents?: { available: boolean; generationAvailable: boolean };
  userOverrides?: { available: boolean };
  organizer?: { available: boolean };
  search?: { available: boolean; mode: string };
}

export async function getBootstrap(signal?: AbortSignal): Promise<Bootstrap> { return api("/api/bootstrap", { signal }); }
export async function getForest(workspace: string, signal?: AbortSignal): Promise<MapForest> {
  return (await api(`/api/scopes/${encodeURIComponent(workspace)}/forest?branches=0`, { signal })).forest;
}
export async function getTurnDirectory(sessionId: string, signal?: AbortSignal): Promise<TurnDirectoryItem[]> {
  const values: TurnDirectoryItem[] = []; let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await api(`/api/sessions/${encodeURIComponent(sessionId)}/turn-directory${query}`, { signal });
    values.push(...page.data);
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    seen.add(page.nextCursor); cursor = page.nextCursor;
  } while (cursor);
  return values;
}
export async function getSessionDetail(sessionId: string, signal?: AbortSignal): Promise<any> {
  const encoded = encodeURIComponent(sessionId);
  const [session, title, parent, override] = await Promise.all([
    api(`/api/sessions/${encoded}`, { signal }), api(`/api/sessions/${encoded}/semantic-title`, { signal }),
    api(`/api/sessions/${encoded}/semantic-parent`, { signal }), api(`/api/sessions/${encoded}/user-overrides/parent`, { signal }),
  ]);
  return { session: session.session, semanticTitle: title.semanticTitle, semanticParent: parent.semanticParent, parentOverride: override.override };
}
export async function getTurnDetail(sessionId: string, nativeTurnId: string, signal?: AbortSignal): Promise<any> {
  return (await api(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(nativeTurnId)}`, { signal })).turn;
}
export async function searchWorkspace(workspace: string, query: string, options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<SearchPage> {
  const params = new URLSearchParams({ q: query, limit: String(options.limit ?? 20) });
  if (options.cursor) params.set("cursor", options.cursor);
  return api(`/api/scopes/${encodeURIComponent(workspace)}/search?${params}`, { signal: options.signal });
}
export async function getSearchStatus(workspace: string, signal?: AbortSignal): Promise<SearchIndexStatus> {
  return (await api(`/api/scopes/${encodeURIComponent(workspace)}/search/status`, { signal })).index;
}
export async function getManualParents(sessionId: string, signal?: AbortSignal): Promise<any[]> {
  return (await api(`/api/sessions/${encodeURIComponent(sessionId)}/manual-parents`, { signal })).candidates;
}
export async function getOverride(sessionId: string, field: "title" | "parent" | "label", nativeTurnId?: string): Promise<any> {
  const query = nativeTurnId ? `?turnId=${encodeURIComponent(nativeTurnId)}` : "";
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/user-overrides/${field}${query}`);
}
export async function writeOverride(sessionId: string, field: "title" | "parent" | "label", value: unknown, revision: number, nativeTurnId?: string): Promise<any> {
  const query = nativeTurnId ? `?turnId=${encodeURIComponent(nativeTurnId)}` : "";
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/user-overrides/${field}${query}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value, revision }),
  });
}
export async function writePlacement(sessionId: string, value: { relation: Relation; parentSessionId?: string; anchorTurnId?: string }): Promise<any> {
  const current = await getOverride(sessionId, "parent");
  return writeOverride(sessionId, "parent", value, current.override.revision);
}
export async function latestEdit(workspace: string): Promise<any> { return (await api(`/api/scopes/${encodeURIComponent(workspace)}/user-edits/latest`)).edit; }
export async function undoEdit(editId: string, revision: number): Promise<any> {
  return (await api(`/api/user-edits/${encodeURIComponent(editId)}/undo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision }) })).edit;
}
export async function startOrganization(workspace: string): Promise<any> {
  return (await api(`/api/scopes/${encodeURIComponent(workspace)}/organize`, { method: "POST" })).job;
}
export async function getOrganization(jobId: string): Promise<any> { return (await api(`/api/organize/${encodeURIComponent(jobId)}`)).job; }

async function api(path: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(path, { ...options, headers: { Accept: "application/json", ...(options.headers ?? {}) } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? `Request failed (${response.status})`);
  return value;
}
