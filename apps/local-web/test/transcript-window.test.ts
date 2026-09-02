import assert from "node:assert/strict";
import test from "node:test";
import { shouldWindowTranscript, transcriptWindow } from "../public/transcript-window.js";

const turns = Array.from({ length: 120 }, (_, index) => ({ id: `turn-${index + 1}` }));

test("large transcripts window around the selected native Turn", () => {
  assert.equal(shouldWindowTranscript({ turns: 120, tools: 1_500, contentChars: 900_000 }), true);
  const window = transcriptWindow(turns, "turn-70", 0, 24);
  assert.equal(window.active, true);
  assert.equal(window.data.some((turn) => turn.id === "turn-70"), true);
  assert.equal(window.data.length, 24);
});

test("small transcripts remain fully rendered", () => {
  assert.equal(shouldWindowTranscript({ turns: 10, tools: 20, contentChars: 20_000 }), false);
  assert.deepEqual(transcriptWindow(turns.slice(0, 10), undefined), { data: turns.slice(0, 10), start: 0, end: 10, active: false });
});
