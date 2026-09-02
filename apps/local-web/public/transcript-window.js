export const TRANSCRIPT_WINDOW_SIZE = 24;
export const TOOL_RENDER_LIMIT = 30;

export function shouldWindowTranscript({ turns, tools, contentChars }) {
  return turns > 80 || tools > 1_000 || contentChars > 750_000;
}

export function transcriptWindow(turns, selectedTurnId, requestedStart = 0, size = TRANSCRIPT_WINDOW_SIZE) {
  if (turns.length <= size) return { data: turns, start: 0, end: turns.length, active: false };
  const selectedIndex = selectedTurnId ? turns.findIndex((turn) => turn.id === selectedTurnId) : -1;
  const maximumStart = Math.max(0, turns.length - size);
  const start = Math.max(0, Math.min(maximumStart, selectedIndex >= 0 ? selectedIndex - Math.floor(size / 2) : requestedStart));
  return { data: turns.slice(start, start + size), start, end: Math.min(turns.length, start + size), active: true };
}
