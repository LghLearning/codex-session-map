import type { NativeLineage, Session, Turn, WorkspaceScope } from "./model.ts";

export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor?: string;
}

export interface SessionProviderCapabilities {
  readonly nativeLineage: "full" | "partial" | "none";
  readonly openSession: boolean;
  readonly openTurn: boolean;
  readonly liveUpdates: boolean;
  readonly titleRead: boolean;
  readonly titleWrite: boolean;
  readonly archiveRead: boolean;
}

export interface SessionProvider {
  getCapabilities(): Promise<SessionProviderCapabilities>;
  listWorkspaceScopes(): Promise<readonly WorkspaceScope[]>;
  listSessions(scopeId: string, cursor?: string): Promise<Page<Session>>;
  readSession(sessionId: string): Promise<Session>;
  listTurns(sessionId: string, cursor?: string): Promise<Page<Turn>>;
  getNativeLineage(sessionId: string): Promise<NativeLineage | null>;
}

export interface SessionProviderUpdate {
  readonly revision: number;
  readonly reason: "provider_notification" | "source_change" | "periodic_reconciliation";
  readonly occurredAt: string;
}

/** Optional capability; consumers must still reconcile at startup. */
export interface LiveSessionProvider extends SessionProvider {
  subscribeUpdates(listener: (update: SessionProviderUpdate) => void): Promise<() => void>;
}

export function supportsLiveUpdates(provider: SessionProvider): provider is LiveSessionProvider {
  return "subscribeUpdates" in provider && typeof (provider as Partial<LiveSessionProvider>).subscribeUpdates === "function";
}
