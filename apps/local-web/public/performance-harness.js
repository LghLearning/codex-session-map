const enabled = true;
const samples = [];
const longTasks = [];
const uncaughtErrors = [];

window.addEventListener("error", (event) => uncaughtErrors.push(String(event.error ?? event.message)));
window.addEventListener("unhandledrejection", (event) => uncaughtErrors.push(String(event.reason)));

if (enabled && "PerformanceObserver" in window) {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // Long-task entries are optional browser telemetry.
  }
}

export function recordNavigationPerformance(sample) {
  if (!enabled) return;
  const memory = performance.memory;
  samples.push({
    ...sample,
    domNodes: document.getElementsByTagName("*").length,
    transcriptScrollHeight: document.getElementById("turn-list")?.scrollHeight,
    heapBytes: memory?.usedJSHeapSize,
    longTaskCount: longTasks.length,
    longTaskDurationMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
    observedAt: new Date().toISOString(),
  });
  publish();
}

export function recordInteractionPerformance(name, startedAt, metadata = {}) {
  if (!enabled) return;
  samples.push({ name, durationMs: performance.now() - startedAt, ...metadata, observedAt: new Date().toISOString() });
  publish();
}

function publish() {
  const output = document.getElementById("performance-metrics");
  if (output) output.textContent = JSON.stringify({ samples, longTasks, uncaughtErrors });
}

if (enabled) Object.defineProperty(window, "__CODEX_SESSION_MAP_BENCHMARK__", {
  value: {
    snapshot: () => ({ samples: samples.map((sample) => ({ ...sample })), longTasks: longTasks.map((task) => ({ ...task })), uncaughtErrors: [...uncaughtErrors] }),
    reset: () => { samples.length = 0; longTasks.length = 0; },
  },
  configurable: false,
  writable: false,
});
