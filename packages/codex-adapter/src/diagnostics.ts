export type CodexDiagnosticCode =
  | "missing_rollout"
  | "orphan_rollout"
  | "duplicate_metadata_id"
  | "multi_segment_session"
  | "partial_line"
  | "corrupt_line"
  | "unknown_event"
  | "project_ambiguity"
  | "unsupported_schema"
  | "app_server_unavailable"
  | "live_update_unavailable"
  | "version_skew"
  | "source_disagreement";

export interface CodexDiagnostic {
  readonly code: CodexDiagnosticCode;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly sessionId?: string;
  readonly sourceKey?: string;
  readonly ordinal?: number;
}

export class DiagnosticCollector {
  readonly #items: CodexDiagnostic[] = [];
  readonly #keys = new Set<string>();
  readonly #limit: number;

  constructor(limit = 1_000) {
    this.#limit = limit;
  }

  add(diagnostic: CodexDiagnostic): void {
    const location = diagnostic.code === "unknown_event" ? "" : `${diagnostic.sourceKey ?? ""}\u0000${diagnostic.ordinal ?? ""}`;
    const key = `${diagnostic.code}\u0000${diagnostic.sessionId ?? ""}\u0000${location}\u0000${diagnostic.message}`;
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    if (this.#items.length < this.#limit) this.#items.push({ ...diagnostic });
  }

  addAll(diagnostics: readonly CodexDiagnostic[]): void {
    for (const diagnostic of diagnostics) this.add(diagnostic);
  }

  snapshot(): readonly CodexDiagnostic[] {
    return this.#items.map((item) => ({ ...item }));
  }

  clear(): void {
    this.#items.length = 0;
    this.#keys.clear();
  }
}
