import type { Connection, Node } from "@xyflow/react";
import type { Relation, SessionMapNodeData, TurnMapNodeData } from "./types.ts";

export interface PlacementDraft { childSessionId: string; parentSessionId: string; anchorTurnId?: string; relation: Relation; legalParentIds?: string[] }

export function connectionToPlacement(connection: Connection, nodes: readonly Node[], relation: Relation = "subtask"): PlacementDraft {
  if (!connection.source.startsWith("session:") || !connection.target) throw new Error("Start from a Session relationship handle.");
  const childSessionId = connection.source.slice("session:".length);
  const target = nodes.find((node) => node.id === connection.target);
  if (!target) throw new Error("Relationship target is unavailable.");
  const parentSessionId = target.type === "session"
    ? (target.data as SessionMapNodeData).session.sessionId
    : target.type === "turn" ? (target.data as TurnMapNodeData).sessionId : undefined;
  if (!parentSessionId) throw new Error("Choose a parent Session or Turn.");
  if (parentSessionId === childSessionId) throw new Error("A Session cannot parent itself.");
  return {
    childSessionId, parentSessionId, relation,
    anchorTurnId: target.type === "turn" ? (target.data as TurnMapNodeData).turn.nativeTurnId : undefined,
  };
}
