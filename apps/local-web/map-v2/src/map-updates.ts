import type { MapForest, SessionNodeData } from "./types.ts";

export function patchSessionTitle(forest: MapForest | undefined, sessionId: string, displayTitle: string): MapForest | undefined {
  if (!forest || !displayTitle) return forest;
  const patch = (session: SessionNodeData): SessionNodeData => session.sessionId === sessionId
    ? { ...session, displayTitle }
    : { ...session, children: session.children.map(patch) };
  return { ...forest, roots: forest.roots.map(patch), unorganized: forest.unorganized.map(patch) };
}
