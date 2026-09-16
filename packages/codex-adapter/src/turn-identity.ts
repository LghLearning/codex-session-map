import { createHash } from "node:crypto";

export interface TurnIdentityAlias {
  readonly providerId: string;
  readonly sessionId: string;
  readonly oldNativeTurnId: string;
  readonly newNativeTurnId: string;
  readonly displayOrdinal?: number;
  readonly boundaryRecordOrdinal?: number;
}

/**
 * A recovered identity is derived from upstream bytes and the logical Session.
 * Registry row ids and physical paths are deliberately excluded.
 */
export function stableSegmentIdentity(sessionId: string, identityPrefixHash: string): string {
  return `segment:v2:${digest(["rollout-segment-v2", sessionId, identityPrefixHash]).slice(0, 24)}`;
}

export function stableRolloutFileIdentity(sessionIds: readonly string[], identityPrefixHash: string): string {
  return `file:v1:${digest(["rollout-file-v1", ...[...sessionIds].sort(), identityPrefixHash]).slice(0, 24)}`;
}

export function recoveredTurnId(sessionId: string, segmentIdentity: string, boundaryRecordOrdinal: number): string {
  return `recovered:v2:${digest(["turn-v2", sessionId, segmentIdentity, String(boundaryRecordOrdinal)]).slice(0, 32)}`;
}

/** Compatibility only: never use this path-derived value for new records. */
export function legacyRecoveredTurnId(path: string, boundaryRecordOrdinal: number): string {
  return `recovered:${createHash("sha256").update(Buffer.from(path)).digest("hex").slice(0, 12)}:${boundaryRecordOrdinal}`;
}

export function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}
