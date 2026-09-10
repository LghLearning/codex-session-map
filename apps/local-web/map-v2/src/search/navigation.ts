import { sessionNodeId, turnNodeId } from "../graph.ts";
import type { SearchResult, Selection } from "../types.ts";

export function resolveSearchNavigation(result: SearchResult, expanded: ReadonlySet<string>, maxExpanded: number): { selection: Exclude<Selection, undefined>; expanded: Set<string>; nodeId: string } {
  if (!result.nativeTurnId) return { selection: { kind: "session", sessionId: result.sessionId }, expanded: new Set(expanded), nodeId: sessionNodeId(result.sessionId) };
  const values = [...expanded].filter((value) => value !== result.sessionId); values.push(result.sessionId);
  return {
    selection: { kind: "turn", sessionId: result.sessionId, nativeTurnId: result.nativeTurnId },
    expanded: new Set(values.slice(-maxExpanded)),
    nodeId: turnNodeId(result.sessionId, result.nativeTurnId),
  };
}
