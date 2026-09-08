import type { MapForest, SessionNodeData, TurnDirectoryItem } from "./types.ts";

const turn = (sessionId: string, ordinal: number, label?: string): TurnDirectoryItem => ({
  nativeTurnId: `${sessionId}/native-${ordinal}`,
  displayOrdinal: ordinal,
  displayLabel: label ?? `Work step ${ordinal}`,
});

const node = (sessionId: string, title: string, children: SessionNodeData[] = [], overrides: Partial<SessionNodeData> = {}): SessionNodeData => ({
  sessionId,
  originalTitle: title,
  displayTitle: title,
  updatedAt: "2026-09-08T08:00:00.000Z",
  turnCount: 4,
  semanticRelation: overrides.semanticRelation ?? "root",
  placementSource: overrides.placementSource ?? "user",
  children,
  ...overrides,
});

const f = node("f", "Validate the final normalization fix", [], { semanticParentSessionId: "d", semanticRelation: "continuation" });
const d = node("d", "Repair the inconsistent training configuration", [f], { semanticParentSessionId: "b", semanticRelation: "subtask" });
const e = node("e", "Compare robust scaling alternatives", [], { semanticParentSessionId: "b", semanticRelation: "subtask" });
const b = node("b", "Branch experiment: compare normalization strategies", [d, e], { semanticParentSessionId: "a", semanticAnchorTurnId: "a/native-3", semanticRelation: "subtask" });
const c = node("c", "Reproduce the issue with an independent dataset", [], { semanticParentSessionId: "a", semanticAnchorTurnId: "a/native-3", semanticRelation: "subtask" });
const s = node("s", "Session-level follow-up without a guessed Turn anchor", [], { semanticParentSessionId: "a", semanticRelation: "continuation" });
const n = node("n", "Native fork retained as separate historical provenance", [], {
  semanticRelation: "root",
  nativeLineage: { parentSessionId: "a", originTurnId: "a/native-5", kind: "user_fork", recovery: "exact" },
});
const a = node("a", "Energy forecasting: diagnose multivariate time-series normalization failures", [b, c, s], { turnCount: 12 });
const x = node("x", "Semantic placement differs from native origin", [], {
  semanticParentSessionId: "g", semanticAnchorTurnId: "g/native-7", semanticRelation: "subtask",
  nativeLineage: { parentSessionId: "a", originTurnId: "a/native-3", kind: "user_fork", recovery: "exact" },
});
const g = node("g", "Architecture exploration and ablation planning", [x], { turnCount: 10 });
const h = node("h", "Export pipeline and report preparation", [node("i", "Figure generation", [], { semanticParentSessionId: "h", semanticRelation: "subtask" })]);

export const prototypeForest: MapForest = {
  workspaceScopeId: "fixture:map-prototype",
  roots: [a, g, h, n],
  unorganized: [
    node("u1", "Unorganized session with no AI title or traces", [], { placementSource: "none" }),
    node("u2", "A deliberately very long original Session title that must remain readable without stretching the map node beyond its fixed presentation width", [], { placementSource: "none" }),
    node("u3", "Independent scratch work", [], { placementSource: "none" }),
  ],
  stats: { sessions: 15, confirmedRoots: 4, unorganized: 3 },
};

export const prototypeTurns = new Map<string, TurnDirectoryItem[]>([
  ["a", Array.from({ length: 12 }, (_, index) => turn("a", index + 1, ["Define the forecasting problem", "Inspect source data", "Find normalization mismatch", "Repair configuration", "Validate results"][index]))],
  ["g", Array.from({ length: 10 }, (_, index) => turn("g", index + 1, index === 6 ? "Choose the final architecture branch" : undefined))],
  ...["b", "c", "d", "e", "f", "h", "i", "n", "s", "u1", "u2", "u3"].map((id) => [id, Array.from({ length: 4 }, (_, index) => turn(id, index + 1))] as [string, TurnDirectoryItem[]]),
]);
