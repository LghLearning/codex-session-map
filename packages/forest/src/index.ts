import type { NativeLineage, Session } from "../../core/src/index.ts";

export type ForestSemanticRelation = "continuation" | "subtask" | "root";

export interface ForestSemanticTitleInput {
  readonly generatedTitle?: string;
  readonly userTitle?: string;
}

export interface ForestSemanticParentInput {
  readonly generatedParentSessionId?: string;
  readonly generatedRelation?: ForestSemanticRelation;
  readonly userParentSessionId?: string;
  readonly userRelation?: ForestSemanticRelation;
  readonly userAnchorTurnId?: string;
}

export interface ForestSessionInput {
  readonly session: Session;
  readonly semanticTitle?: ForestSemanticTitleInput;
  readonly semanticParent?: ForestSemanticParentInput;
  readonly nativeLineage?: NativeLineage | null;
  readonly turnCount: number;
  readonly traceCount: number;
}

export interface SessionForestNode {
  readonly sessionId: string;
  readonly originalTitle: string;
  readonly displayTitle: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly archiveStatus: Session["archiveStatus"];
  readonly health: Session["health"];
  readonly turnCount: number;
  readonly traceCount: number;
  readonly semanticParentSessionId?: string;
  readonly semanticRelation: ForestSemanticRelation;
  readonly placementSource: "user" | "ai" | "none";
  readonly semanticAnchorTurnId?: string;
  readonly nativeLineage?: NativeLineage | null;
  readonly children: readonly SessionForestNode[];
}

export interface SessionForestIssue {
  readonly code: "missing_parent" | "self_parent" | "cycle_broken";
  readonly sessionId: string;
  readonly parentSessionId?: string;
}

export interface SessionForestStats {
  readonly sessions: number;
  readonly confirmedRoots: number;
  readonly unorganized: number;
  readonly semanticEdges: number;
  readonly userCorrected: number;
  readonly missingTitles: number;
  readonly missingTraces: number;
}

export interface SessionForest {
  readonly workspaceScopeId: string;
  readonly roots: readonly SessionForestNode[];
  readonly unorganized: readonly SessionForestNode[];
  readonly stats: SessionForestStats;
  readonly issues: readonly SessionForestIssue[];
  /** Optional Turn-chain branch projection for consumers that load a lightweight Turn directory. */
  readonly branches?: readonly SessionBranchProjection[];
}

interface MutableNode extends Omit<SessionForestNode, "children"> {
  children: MutableNode[];
}

/** Deterministic projection. Invalid/missing edges degrade to roots; Sessions are never hidden. */
export function materializeSessionForest(workspaceScopeId: string, inputs: readonly ForestSessionInput[]): SessionForest {
  const workspaceInputs = inputs.filter((input) => input.session.workspaceScopeId === workspaceScopeId);
  const nodes = new Map<string, MutableNode>();
  const issues: SessionForestIssue[] = [];
  const parentByChild = new Map<string, string>();

  for (const input of workspaceInputs) {
    const placement = preferredPlacement(input.semanticParent);
    nodes.set(input.session.providerSessionId, {
      sessionId: input.session.providerSessionId,
      originalTitle: input.session.title,
      displayTitle: input.semanticTitle?.userTitle ?? input.semanticTitle?.generatedTitle ?? (input.session.title || "Untitled Session"),
      createdAt: input.session.createdAt,
      updatedAt: input.session.updatedAt,
      archiveStatus: input.session.archiveStatus,
      health: input.session.health,
      turnCount: input.turnCount,
      traceCount: input.traceCount,
      semanticParentSessionId: placement.parentSessionId,
      semanticRelation: placement.relation,
      placementSource: placement.source,
      semanticAnchorTurnId: placement.anchorTurnId,
      nativeLineage: input.nativeLineage,
      children: [],
    });
  }

  for (const node of nodes.values()) {
    if (node.semanticRelation === "root" || !node.semanticParentSessionId) continue;
    if (node.semanticParentSessionId === node.sessionId) {
      issues.push({ code: "self_parent", sessionId: node.sessionId, parentSessionId: node.semanticParentSessionId });
      rootNode(node);
    } else if (!nodes.has(node.semanticParentSessionId)) {
      issues.push({ code: "missing_parent", sessionId: node.sessionId, parentSessionId: node.semanticParentSessionId });
      rootNode(node);
    } else parentByChild.set(node.sessionId, node.semanticParentSessionId);
  }

  breakCycles(parentByChild, nodes, issues);

  const roots: MutableNode[] = [];
  const unorganized: MutableNode[] = [];
  for (const node of nodes.values()) {
    const parentId = parentByChild.get(node.sessionId);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else if (node.placementSource === "none") unorganized.push(node);
    else roots.push(node);
  }
  sortTree(roots);
  sortTree(unorganized);

  const semanticEdges = [...nodes.values()].filter((node) => node.semanticRelation !== "root" && Boolean(parentByChild.get(node.sessionId))).length;
  return {
    workspaceScopeId,
    roots,
    unorganized,
    issues,
    stats: {
      sessions: nodes.size,
      confirmedRoots: roots.length,
      unorganized: [...nodes.values()].filter((node) => node.placementSource === "none").length,
      semanticEdges,
      userCorrected: workspaceInputs.filter((input) => Boolean(input.semanticParent?.userRelation)).length,
      missingTitles: workspaceInputs.filter((input) => !input.semanticTitle).length,
      missingTraces: workspaceInputs.reduce((sum, input) => sum + Math.max(0, input.turnCount - input.traceCount), 0),
    },
  };
}

function preferredPlacement(edge: ForestSemanticParentInput | undefined): {
  parentSessionId?: string;
  anchorTurnId?: string;
  relation: ForestSemanticRelation;
  source: "user" | "ai" | "none";
} {
  if (!edge) return { relation: "root", source: "none" };
  if (edge.userRelation) return {
    parentSessionId: edge.userRelation === "root" ? undefined : edge.userParentSessionId,
    anchorTurnId: edge.userRelation === "root" ? undefined : edge.userAnchorTurnId,
    relation: edge.userRelation,
    source: "user",
  };
  return {
    parentSessionId: edge.generatedRelation === "root" ? undefined : edge.generatedParentSessionId,
    relation: edge.generatedRelation ?? "root",
    source: edge.generatedRelation ? "ai" : "none",
  };
}

export interface BranchTurn {
  readonly nativeTurnId: string;
  readonly displayOrdinal: number;
  readonly displayLabel: string;
}

export interface BranchAttachment {
  readonly childSessionId: string;
  readonly childTitle: string;
  readonly relation: ForestSemanticRelation | "native";
  readonly source: "user" | "ai" | "native";
  readonly anchorTurnId: string;
  readonly anchorAvailability: "available" | "unavailable";
}

export interface SessionBranchProjection {
  readonly sessionId: string;
  readonly turns: readonly (BranchTurn & { readonly childSessions: readonly BranchAttachment[] })[];
  readonly sessionLevelChildren: readonly Omit<BranchAttachment, "anchorTurnId" | "anchorAvailability">[];
  readonly unavailableAnchors: readonly BranchAttachment[];
}

/** Builds a display projection only. Turn order and identities come exclusively from the provider directory. */
export function projectSessionBranches(
  inputs: readonly ForestSessionInput[],
  turnsBySession: ReadonlyMap<string, readonly BranchTurn[]>,
): readonly SessionBranchProjection[] {
  const sessions = new Map(inputs.map((input) => [input.session.providerSessionId, input]));
  const anchored = new Map<string, BranchAttachment[]>();
  const sessionLevel = new Map<string, Omit<BranchAttachment, "anchorTurnId" | "anchorAvailability">[]>();
  const attach = (parentId: string, value: BranchAttachment) => anchored.set(parentId, [...anchored.get(parentId) ?? [], value]);
  for (const input of inputs) {
    const placement = preferredPlacement(input.semanticParent);
    const title = input.semanticTitle?.userTitle ?? input.semanticTitle?.generatedTitle ?? input.session.title;
    if (placement.relation !== "root" && placement.parentSessionId && sessions.has(placement.parentSessionId)) {
      if (placement.anchorTurnId) attach(placement.parentSessionId, {
        childSessionId: input.session.providerSessionId, childTitle: title, relation: placement.relation,
        source: placement.source === "none" ? "ai" : placement.source, anchorTurnId: placement.anchorTurnId,
        anchorAvailability: turnsBySession.get(placement.parentSessionId)?.some((turn) => turn.nativeTurnId === placement.anchorTurnId) ? "available" : "unavailable",
      });
      else sessionLevel.set(placement.parentSessionId, [...sessionLevel.get(placement.parentSessionId) ?? [], {
        childSessionId: input.session.providerSessionId, childTitle: title, relation: placement.relation, source: placement.source === "none" ? "ai" : placement.source,
      }]);
    }
    const native = input.nativeLineage;
    if (native?.parentSessionId && native.originTurnId && native.recovery === "exact" && sessions.has(native.parentSessionId)) attach(native.parentSessionId, {
      childSessionId: input.session.providerSessionId, childTitle: title, relation: "native", source: "native",
      anchorTurnId: native.originTurnId,
      anchorAvailability: turnsBySession.get(native.parentSessionId)?.some((turn) => turn.nativeTurnId === native.originTurnId) ? "available" : "unavailable",
    });
  }
  return inputs.map((input) => {
    const sessionId = input.session.providerSessionId;
    const turns = turnsBySession.get(sessionId) ?? [];
    const attachments = anchored.get(sessionId) ?? [];
    return {
      sessionId,
      turns: turns.map((turn) => ({ ...turn, childSessions: attachments.filter((child) => child.anchorTurnId === turn.nativeTurnId && child.anchorAvailability === "available") })),
      sessionLevelChildren: sessionLevel.get(sessionId) ?? [],
      unavailableAnchors: attachments.filter((child) => child.anchorAvailability === "unavailable"),
    };
  });
}

function breakCycles(parentByChild: Map<string, string>, nodes: Map<string, MutableNode>, issues: SessionForestIssue[]): void {
  while (true) {
    const cycle = findCycle(parentByChild);
    if (!cycle.length) return;
    const brokenSessionId = [...cycle].sort().at(-1)!;
    const parentSessionId = parentByChild.get(brokenSessionId);
    parentByChild.delete(brokenSessionId);
    const node = nodes.get(brokenSessionId)!;
    rootNode(node);
    issues.push({ code: "cycle_broken", sessionId: brokenSessionId, parentSessionId });
  }
}

function findCycle(parentByChild: Map<string, string>): readonly string[] {
  const globallyDone = new Set<string>();
  for (const start of parentByChild.keys()) {
    if (globallyDone.has(start)) continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = start;
    while (current && !globallyDone.has(current)) {
      const prior = position.get(current);
      if (prior !== undefined) return path.slice(prior);
      position.set(current, path.length);
      path.push(current);
      current = parentByChild.get(current);
    }
    for (const sessionId of path) globallyDone.add(sessionId);
  }
  return [];
}

function rootNode(node: MutableNode): void {
  delete (node as { semanticParentSessionId?: string }).semanticParentSessionId;
  delete (node as { semanticAnchorTurnId?: string }).semanticAnchorTurnId;
  (node as { semanticRelation: ForestSemanticRelation }).semanticRelation = "root";
  (node as { placementSource: "user" | "ai" | "none" }).placementSource = "none";
}

function sortTree(nodes: MutableNode[]): void {
  nodes.sort(compareNodes);
  for (const node of nodes) sortTree(node.children);
}

function compareNodes(left: MutableNode, right: MutableNode): number {
  const leftTime = Date.parse(left.createdAt ?? "");
  const rightTime = Date.parse(right.createdAt ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return left.displayTitle.localeCompare(right.displayTitle) || left.sessionId.localeCompare(right.sessionId);
}
