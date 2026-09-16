import type { Edge, Node, XYPosition } from "@xyflow/react";
import type { MapForest, SectionMapNodeData, Selection, SessionMapNodeData, SessionNodeData, TurnDirectoryItem, TurnMapNodeData } from "./types.ts";

export const SESSION_WIDTH = 292;
export const COLLAPSED_HEIGHT = 104;
export const TURN_HEIGHT = 56;
const TURN_TOP = 92;
const TURN_GAP = 10;
const COLUMN_GAP = 210;
const TREE_GAP = 90;

export interface MapGraphOptions {
  forest: MapForest;
  expanded: ReadonlySet<string>;
  turnDirectories: ReadonlyMap<string, readonly TurnDirectoryItem[]>;
  selection?: Selection;
  positions?: Readonly<Record<string, XYPosition>>;
  showNative?: boolean;
  turnStates?: ReadonlyMap<string, "loading" | "error">;
  onToggle?: (sessionId: string) => void;
  onRetryTurns?: (sessionId: string) => void;
}

export interface MapGraph {
  nodes: Node<SessionMapNodeData | TurnMapNodeData | SectionMapNodeData>[];
  edges: Edge[];
  bounds: { width: number; height: number };
}

export function buildMapGraph(options: MapGraphOptions): MapGraph {
  const nodes: MapGraph["nodes"] = [];
  const edges: Edge[] = [];
  const sessions = flattenSessions([...options.forest.roots, ...options.forest.unorganized]);
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const roots = options.forest.roots;
  let cursorY = 40;
  for (const root of roots) {
    placeTree(root, 40, cursorY, options, nodes, edges);
    cursorY += measureTree(root, options) + TREE_GAP;
  }
  if (options.forest.unorganized.length) {
    nodes.push({ id: "section:unorganized", type: "section", position: { x: 40, y: cursorY }, data: { kind: "section", label: "Not organized yet" }, draggable: false, selectable: false });
    cursorY += 48;
    for (const session of options.forest.unorganized) {
      placeTree(session, 40, cursorY, options, nodes, edges);
      cursorY += measureTree(session, options) + 34;
    }
  }
  for (const session of sessions) {
    if (!session.semanticParentSessionId || !byId.has(session.semanticParentSessionId)) continue;
    const parentExpanded = options.expanded.has(session.semanticParentSessionId);
    const directory = options.turnDirectories.get(session.semanticParentSessionId) ?? [];
    const anchorExists = parentExpanded && session.semanticAnchorTurnId && directory.some((turn) => turn.nativeTurnId === session.semanticAnchorTurnId);
    edges.push({
      id: `semantic:${session.sessionId}`,
      source: anchorExists ? turnNodeId(session.semanticParentSessionId, session.semanticAnchorTurnId!) : sessionNodeId(session.semanticParentSessionId),
      sourceHandle: "branch-out",
      target: sessionNodeId(session.sessionId),
      targetHandle: "branch-in",
      type: "smoothstep",
      className: `semantic-edge ${session.placementSource}`,
      label: session.semanticAnchorTurnId && !anchorExists ? "Related Turn not loaded" : session.semanticRelation,
      animated: false,
    });
  }
  if (options.showNative) for (const session of sessions) {
    const native = session.nativeLineage;
    if (!native?.parentSessionId || !byId.has(native.parentSessionId)) continue;
    const directory = options.turnDirectories.get(native.parentSessionId) ?? [];
    const exact = options.expanded.has(native.parentSessionId) && native.recovery === "exact" && native.originTurnId && directory.some((turn) => turn.nativeTurnId === native.originTurnId);
    edges.push({
      id: `native:${session.sessionId}`,
      source: exact ? turnNodeId(native.parentSessionId, native.originTurnId!) : sessionNodeId(native.parentSessionId),
      sourceHandle: "branch-out", target: sessionNodeId(session.sessionId), targetHandle: "branch-in", type: "smoothstep", className: "native-edge", label: "Original branch source",
    });
  }
  const width = nodes.reduce((max, node) => Math.max(max, node.position.x + (node.type === "turn" ? 236 : SESSION_WIDTH)), 0) + 80;
  const height = nodes.reduce((max, node) => Math.max(max, node.position.y + Number(node.style?.height ?? COLLAPSED_HEIGHT)), 0) + 80;
  return { nodes, edges, bounds: { width, height } };
}

function placeTree(session: SessionNodeData, x: number, top: number, options: MapGraphOptions, nodes: MapGraph["nodes"], edges: Edge[]): void {
  const subtreeHeight = measureTree(session, options);
  const height = sessionHeight(session, options);
  const computed = { x, y: top + Math.max(0, (subtreeHeight - height) / 2) };
  const position = options.positions?.[sessionNodeId(session.sessionId)] ?? computed;
  const expanded = options.expanded.has(session.sessionId);
  nodes.push({
    id: sessionNodeId(session.sessionId), type: "session", position, style: { width: SESSION_WIDTH, height },
    data: { kind: "session", session, expanded, selected: options.selection?.kind === "session" && options.selection.sessionId === session.sessionId, turnState: options.turnStates?.get(session.sessionId), onToggle: options.onToggle, onRetryTurns: options.onRetryTurns },
  });
  if (expanded) {
    const turns = options.turnDirectories.get(session.sessionId) ?? [];
    turns.forEach((turn, index) => {
      nodes.push({
        id: turnNodeId(session.sessionId, turn.nativeTurnId), type: "turn", parentId: sessionNodeId(session.sessionId), extent: "parent",
        position: { x: 25, y: TURN_TOP + index * (TURN_HEIGHT + TURN_GAP) }, draggable: false,
        data: { kind: "turn", sessionId: session.sessionId, turn, selected: options.selection?.kind === "turn" && options.selection.nativeTurnId === turn.nativeTurnId },
      });
      if (index) edges.push({ id: `turn:${session.sessionId}:${index}`, source: turnNodeId(session.sessionId, turns[index - 1].nativeTurnId), sourceHandle: "chain-out", target: turnNodeId(session.sessionId, turn.nativeTurnId), targetHandle: "chain-in", type: "straight", className: "turn-chain-edge" });
    });
  }
  let childTop = top;
  for (const child of session.children) {
    placeTree(child, x + SESSION_WIDTH + COLUMN_GAP, childTop, options, nodes, edges);
    childTop += measureTree(child, options) + 26;
  }
}

function measureTree(session: SessionNodeData, options: MapGraphOptions): number {
  const own = sessionHeight(session, options);
  if (!session.children.length) return own;
  const children = session.children.reduce((sum, child) => sum + measureTree(child, options), 0) + Math.max(0, session.children.length - 1) * 26;
  return Math.max(own, children);
}

function sessionHeight(session: SessionNodeData, options: MapGraphOptions): number {
  if (!options.expanded.has(session.sessionId)) return COLLAPSED_HEIGHT;
  const turns = options.turnDirectories.get(session.sessionId)?.length ?? 0;
  return Math.max(COLLAPSED_HEIGHT + 24, TURN_TOP + turns * (TURN_HEIGHT + TURN_GAP) + 18);
}

export const sessionNodeId = (sessionId: string) => `session:${sessionId}`;
export const turnNodeId = (sessionId: string, nativeTurnId: string) => `turn:${sessionId}:${nativeTurnId}`;

export function flattenSessions(roots: readonly SessionNodeData[]): SessionNodeData[] {
  return roots.flatMap((node) => [node, ...flattenSessions(node.children)]);
}
