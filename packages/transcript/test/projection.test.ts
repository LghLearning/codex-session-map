import assert from "node:assert/strict";
import test from "node:test";
import type { Turn } from "../../core/src/index.ts";
import { projectTranscriptTurn } from "../src/index.ts";

test("transcript projection keeps native identity without leaking provider provenance", () => {
  const turn: Turn = {
    providerId: "fixture-provider",
    sessionId: "session-a",
    nativeTurnId: "native-turn-17",
    displayOrdinal: 4,
    initiatorKind: "user",
    status: "completed",
    input: { text: "Inspect the adapter", attachments: [] },
    assistantFinal: "Inspection complete.",
    tools: [{ name: "read", status: "completed", outputSummary: "one file" }],
    partial: false,
    health: { state: "complete", issues: [] },
    provenance: [{ providerId: "fixture-provider", tier: "primary", recordKey: "private-record", completeness: "complete" }],
  };

  const view = projectTranscriptTurn(turn);
  assert.equal(view.id, "native-turn-17");
  assert.equal(view.ordinal, 4);
  assert.equal(view.tools[0]?.name, "read");
  assert.equal("providerId" in view, false);
  assert.equal("provenance" in view, false);
});
