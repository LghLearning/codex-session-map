import type { PersistedWorkspaceState, Selection } from "./types.ts";

const PREFIX = "codex-session-map:v2:";
const LAST_WORKSPACE = `${PREFIX}last-workspace`;
const MAX_RESTORED_EXPANDED = 12;

export function readWorkspaceState(storage: Pick<Storage, "getItem">, workspace: string): PersistedWorkspaceState {
  try {
    const parsed = JSON.parse(storage.getItem(PREFIX + workspace) ?? "{}");
    return {
      expandedSessionIds: Array.isArray(parsed.expandedSessionIds) ? parsed.expandedSessionIds.filter((value: unknown) => typeof value === "string").slice(-MAX_RESTORED_EXPANDED) : [],
      positions: parsed.positions && typeof parsed.positions === "object" ? parsed.positions : {},
      viewport: validViewport(parsed.viewport) ? parsed.viewport : undefined,
      selection: validSelection(parsed.selection) ? parsed.selection : undefined,
      railCollapsed: Boolean(parsed.railCollapsed), showNative: Boolean(parsed.showNative),
    };
  } catch { return { expandedSessionIds: [], positions: {} }; }
}

export function saveWorkspaceState(storage: Pick<Storage, "setItem">, workspace: string, value: PersistedWorkspaceState): void {
  storage.setItem(PREFIX + workspace, JSON.stringify({ ...value, expandedSessionIds: value.expandedSessionIds.slice(-MAX_RESTORED_EXPANDED) }));
}

export function readLastWorkspace(storage: Pick<Storage, "getItem">): string | undefined {
  const value = storage.getItem(LAST_WORKSPACE);
  return value || undefined;
}

export function saveLastWorkspace(storage: Pick<Storage, "setItem">, workspace: string): void { storage.setItem(LAST_WORKSPACE, workspace); }

export function selectionFromUrl(url: URL): Selection {
  const sessionId = url.searchParams.get("session") ?? undefined;
  const nativeTurnId = url.searchParams.get("turn") ?? undefined;
  if (sessionId && nativeTurnId) return { kind: "turn", sessionId, nativeTurnId };
  return sessionId ? { kind: "session", sessionId } : undefined;
}

export function updateMapUrl(url: URL, workspace: string, selection?: Selection): string {
  const next = new URL(url);
  next.pathname = url.pathname === "/" ? "/" : "/map-v2";
  next.searchParams.set("view", "map");
  next.searchParams.set("workspace", workspace);
  selection ? next.searchParams.set("session", selection.sessionId) : next.searchParams.delete("session");
  selection?.kind === "turn" ? next.searchParams.set("turn", selection.nativeTurnId) : next.searchParams.delete("turn");
  return `${next.pathname}${next.search}`;
}

export function resolveRestoredSelection(url: URL, saved?: Selection): Selection { return selectionFromUrl(url) ?? saved; }

export class RequestSequence {
  #value = 0;
  start(): number { return ++this.#value; }
  current(token: number): boolean { return token === this.#value; }
}

export interface LiveSafeState { selection?: Selection; viewport?: PersistedWorkspaceState["viewport"]; expandedSessionIds: string[]; draft?: unknown }
export function preserveInteractionState(current: LiveSafeState): LiveSafeState {
  return { selection: current.selection, viewport: current.viewport, expandedSessionIds: [...current.expandedSessionIds], draft: current.draft };
}

function validViewport(value: any): boolean { return value && [value.x, value.y, value.zoom].every(Number.isFinite); }
function validSelection(value: any): value is Selection { return value?.kind === "session" && typeof value.sessionId === "string" || value?.kind === "turn" && typeof value.sessionId === "string" && typeof value.nativeTurnId === "string"; }
