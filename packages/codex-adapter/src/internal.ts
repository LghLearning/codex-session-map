import type { NativeLineage, TurnStatus } from "../../core/src/index.ts";

export interface CodexProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly roots: readonly string[];
}

export interface CodexThreadRecord {
  readonly id: string;
  readonly title?: string;
  readonly preview?: string;
  readonly cwd?: string;
  readonly observedCwds: readonly string[];
  readonly projectId?: string;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
  readonly archived?: boolean;
  readonly source?: string;
  readonly historyMode?: string;
  readonly rolloutPaths: readonly string[];
  readonly physicalSegmentCount?: number;
  readonly sourceTier: "primary" | "structured_fallback" | "reconciliation";
  readonly partial: boolean;
  readonly nativeLineage?: NativeLineage;
}

export interface CodexTurnRecord {
  readonly sessionId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly status: TurnStatus;
  readonly initiator: "user" | "agent" | "system" | "unknown";
  readonly inputText?: string;
  readonly assistantFinal?: string;
  readonly attachments: readonly { kind: "image" | "file" | "audio" | "unknown"; name?: string; mimeType?: string }[];
  readonly tools: readonly CodexToolRecord[];
  readonly startedAtMs?: number;
  readonly completedAtMs?: number;
  readonly sourceTier: "primary" | "structured_fallback" | "reconciliation";
  readonly partial: boolean;
  readonly issues: readonly string[];
}

export interface CodexToolRecord {
  readonly callId?: string;
  readonly name: string;
  readonly status: "requested" | "completed" | "failed" | "unknown";
  readonly inputSummary?: string;
  readonly outputSummary?: string;
}

export interface SourceSnapshot {
  readonly threads: readonly CodexThreadRecord[];
  readonly projects: readonly CodexProjectRecord[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function compactText(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
