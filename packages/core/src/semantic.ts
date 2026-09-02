/** Provider-neutral identity of one logical Turn. */
export interface TurnIdentity {
  readonly providerId: string;
  readonly sessionId: string;
  readonly nativeTurnId: string;
}

/** Identifies the reproducible generator contract, not a user-authored override. */
export interface SemanticGeneratorIdentity {
  readonly id: string;
  readonly version: string;
  readonly model?: string;
}

/**
 * Rebuildable one-line semantic projection of a Turn's public persisted content.
 * Semantic parents, Session titles, user edits, and native lineage are deliberately absent.
 */
export interface TurnSemanticTrace extends TurnIdentity {
  readonly text: string;
  readonly inputFingerprint: string;
  readonly generator: SemanticGeneratorIdentity;
  readonly generatedAt: string;
}

export type SemanticTraceFreshness = "missing" | "current" | "stale";

export interface SemanticTraceLookup {
  readonly freshness: SemanticTraceFreshness;
  readonly trace?: TurnSemanticTrace;
  readonly currentInputFingerprint: string;
}
