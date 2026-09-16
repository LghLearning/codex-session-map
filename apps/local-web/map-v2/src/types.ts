export type Relation = "continuation" | "subtask" | "root";
export type PlacementSource = "user" | "ai" | "none";

export interface NativeLineage {
  parentSessionId?: string;
  originTurnId?: string;
  kind: string;
  recovery: "exact" | "session_only" | "ambiguous";
}

export interface SessionNodeData {
  sessionId: string;
  originalTitle: string;
  displayTitle: string;
  createdAt?: string;
  updatedAt?: string;
  turnCount: number;
  semanticParentSessionId?: string;
  semanticAnchorTurnId?: string;
  semanticRelation: Relation;
  placementSource: PlacementSource;
  nativeLineage?: NativeLineage | null;
  children: SessionNodeData[];
}

export interface TurnDirectoryItem {
  nativeTurnId: string;
  displayOrdinal: number;
  displayLabel: string;
}

export type SearchSourceKind = "session_title" | "turn_label" | "turn_summary" | "user_input" | "assistant_final";
export interface SearchIndexStatus { state: "idle" | "indexing" | "ready" | "error"; freshness?: "verified" | "unverified" | "stale"; totalSessions: number; indexedSessions: number; indexedTurns: number; coverage: number; error?: string }
export interface SearchResult { sessionId: string; nativeTurnId?: string; displayOrdinal?: number; sessionTitle: string; timestamp?: string; sourceKind: SearchSourceKind; snippet: string; highlights: { start: number; end: number }[] }
export interface SearchPage { query: string; results: SearchResult[]; nextCursor?: string; mode: "fts5_trigram" | "substring_fallback"; index: SearchIndexStatus }

export interface MapForest {
  workspaceScopeId: string;
  roots: SessionNodeData[];
  unorganized: SessionNodeData[];
  stats: { sessions: number; confirmedRoots: number; unorganized: number };
}

export type Selection =
  | { kind: "session"; sessionId: string }
  | { kind: "turn"; sessionId: string; nativeTurnId: string }
  | undefined;

export interface PersistedWorkspaceState {
  expandedSessionIds: string[];
  positions: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
  selection?: Selection;
  railCollapsed?: boolean;
  showNative?: boolean;
}

export interface SessionMapNodeData extends Record<string, unknown> {
  kind: "session";
  session: SessionNodeData;
  expanded: boolean;
  selected: boolean;
  turnState?: "loading" | "error";
  onToggle?: (sessionId: string) => void;
  onRetryTurns?: (sessionId: string) => void;
}

export interface TurnMapNodeData extends Record<string, unknown> {
  kind: "turn";
  sessionId: string;
  turn: TurnDirectoryItem;
  selected: boolean;
}

export interface SectionMapNodeData extends Record<string, unknown> {
  kind: "section";
  label: string;
}
