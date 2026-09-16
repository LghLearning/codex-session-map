import { realpathSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";

export type SourceInvalidationReason = "source_change" | "periodic_reconciliation";
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 300_000;

export function resolveWatchPath(
  directory: string,
  platform: NodeJS.Platform = process.platform,
  resolveNativePath: (path: string) => string = realpathSync.native,
): string {
  if (platform !== "win32") return directory;
  try {
    return resolveNativePath(directory);
  } catch {
    return directory;
  }
}

export interface CodexUpdateMonitorOptions {
  readonly sessionsDirectory: string;
  readonly archivedSessionsDirectory: string;
  readonly stateDatabase?: string;
  readonly historyDatabase?: string;
  readonly debounceMs?: number;
  readonly reconciliationIntervalMs?: number;
  /** Testable escape hatch: correctness must still come from reconciliation. */
  readonly disableFilesystemWatch?: boolean;
  readonly onInvalidate: (reason: SourceInvalidationReason, paths?: readonly string[]) => Promise<void> | void;
  readonly onWatchError?: (error: Error) => void;
}

/**
 * Filesystem events are latency hints only. The periodic invalidation is the
 * correctness path when an OS watcher drops, coalesces, or misses an event.
 */
export class CodexUpdateMonitor {
  readonly #options: CodexUpdateMonitorOptions;
  readonly #watchers: FSWatcher[] = [];
  #debounce?: NodeJS.Timeout;
  #reconciliation?: NodeJS.Timeout;
  #closed = false;
  #running = false;
  #pendingReason?: SourceInvalidationReason;
  readonly #pendingPaths = new Set<string>();
  #pendingUnknown = false;

  constructor(options: CodexUpdateMonitorOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#closed || this.#watchers.length || this.#reconciliation) return;
    if (!this.#options.disableFilesystemWatch) {
      this.#watchDirectory(this.#options.sessionsDirectory, true);
      this.#watchDirectory(this.#options.archivedSessionsDirectory, true);
      for (const database of [this.#options.stateDatabase, this.#options.historyDatabase]) {
        if (database) this.#watchDirectory(dirname(database), false, database);
      }
    }
    const interval = Math.max(50, this.#options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS);
    this.#reconciliation = setInterval(() => this.#queue("periodic_reconciliation", 0), interval);
    this.#reconciliation.unref();
  }

  close(): void {
    this.#closed = true;
    if (this.#debounce) clearTimeout(this.#debounce);
    if (this.#reconciliation) clearInterval(this.#reconciliation);
    for (const watcher of this.#watchers.splice(0)) watcher.close();
  }

  #watchDirectory(directory: string, recursive: boolean, exactFile?: string): void {
    try {
      const exactName = exactFile ? basename(exactFile) : undefined;
      const watcher = watch(resolveWatchPath(directory), { recursive }, (_event, filename) => {
        if (exactName && filename && !String(filename).startsWith(exactName)) return;
        const changedPath = filename ? join(directory, String(filename)) : exactFile;
        this.#queue("source_change", this.#options.debounceMs ?? 350, changedPath);
      });
      watcher.on("error", (error) => this.#options.onWatchError?.(error));
      this.#watchers.push(watcher);
    } catch (error) {
      this.#options.onWatchError?.(error instanceof Error ? error : new Error("Unknown filesystem watcher error"));
    }
  }

  #queue(reason: SourceInvalidationReason, delay: number, changedPath?: string): void {
    if (this.#closed) return;
    this.#pendingReason = this.#pendingReason === "source_change" ? "source_change" : reason;
    if (reason === "source_change") {
      if (changedPath) this.#pendingPaths.add(changedPath);
      else this.#pendingUnknown = true;
    }
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => void this.#flush(), delay);
    this.#debounce.unref();
  }

  async #flush(): Promise<void> {
    if (this.#closed) return;
    if (this.#running) {
      this.#pendingReason ??= "source_change";
      return;
    }
    const reason = this.#pendingReason ?? "periodic_reconciliation";
    const paths = this.#pendingUnknown ? undefined : [...this.#pendingPaths];
    this.#pendingReason = undefined;
    this.#pendingPaths.clear();
    this.#pendingUnknown = false;
    this.#running = true;
    try {
      await this.#options.onInvalidate(reason, paths?.length ? paths : undefined);
    } finally {
      this.#running = false;
      if (this.#pendingReason) this.#queue(this.#pendingReason, this.#options.debounceMs ?? 350);
    }
  }
}
