import type { Turn } from "../../core/src/index.ts";

/** Provider-neutral seam for a later euphony-conversation integration. */
export interface TranscriptRendererPort<Output> {
  render(turns: readonly Turn[]): Output;
}

export interface TranscriptTurnView {
  readonly id: string;
  readonly ordinal: number;
  readonly initiator: Turn["initiatorKind"];
  readonly status: Turn["status"];
  readonly input?: string;
  readonly attachments: Turn["input"]["attachments"];
  readonly assistantFinal?: string;
  readonly tools: Turn["tools"];
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly partial: boolean;
  readonly health: Turn["health"];
}

/**
 * Converts Core turns into a stable, provider-neutral transcript view model.
 * It intentionally performs no semantic summarization and does not inspect
 * provider provenance or raw Codex events.
 */
export function projectTranscriptTurn(turn: Turn): TranscriptTurnView {
  return {
    id: turn.nativeTurnId,
    ordinal: turn.displayOrdinal,
    initiator: turn.initiatorKind,
    status: turn.status,
    input: turn.input.text,
    attachments: turn.input.attachments,
    assistantFinal: turn.assistantFinal,
    tools: turn.tools,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    partial: turn.partial,
    health: turn.health,
  };
}
