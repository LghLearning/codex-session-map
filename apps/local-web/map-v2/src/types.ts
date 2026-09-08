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

