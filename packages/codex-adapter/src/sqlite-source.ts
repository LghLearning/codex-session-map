import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DiagnosticCollector } from "./diagnostics.ts";
import type { CodexProjectRecord, CodexThreadRecord, CodexTurnRecord, SourceSnapshot } from "./internal.ts";
import { isRecord } from "./internal.ts";
import { projectAppServerTurns } from "./app-server-source.ts";

export interface StructuredSourceOptions {
  readonly codexHome: string;
  readonly diagnostics: DiagnosticCollector;
  readonly stateDatabase?: string;
  readonly historyDatabase?: string;
}

export interface StructuredPaths {
  readonly stateDatabase?: string;
  readonly historyDatabase?: string;
}

export class StructuredCodexSource {
  readonly #options: StructuredSourceOptions;
  paths: StructuredPaths = {};

  constructor(options: StructuredSourceOptions) {
    this.#options = options;
  }

  async discover(): Promise<StructuredPaths> {
    const names = await readdir(this.#options.codexHome).catch(() => []);
    const stateDatabase = this.#options.stateDatabase ?? newestVersioned(names, /^state_(\d+)\.sqlite$/, this.#options.codexHome);
    const historyDatabase = this.#options.historyDatabase ?? newestVersioned(names, /^thread_history_(\d+)\.sqlite$/, this.#options.codexHome);
    this.paths = { stateDatabase, historyDatabase };
    return this.paths;
  }

  async list(): Promise<SourceSnapshot> {
    const paths = await this.discover();
    if (!paths.stateDatabase) {
      this.#options.diagnostics.add({ code: "unsupported_schema", severity: "error", message: "No state_*.sqlite database was found." });
      return { threads: [], projects: [] };
    }
    const db = openReadOnly(paths.stateDatabase);
    try {
      if (!tableExists(db, "threads")) {
        this.#options.diagnostics.add({ code: "unsupported_schema", severity: "error", message: "The state database has no threads table." });
        return { threads: [], projects: [] };
      }
      const columns = tableColumns(db, "threads");
      for (const required of ["id", "cwd", "created_at", "updated_at", "archived"]) {
        if (!columns.has(required)) this.#options.diagnostics.add({ code: "unsupported_schema", severity: "warning", message: `threads.${required} is unavailable; projection will be partial.` });
      }
      const selected = [
        "id", "rollout_path", "created_at", "updated_at", "created_at_ms", "updated_at_ms",
        "source", "thread_source", "cwd", "title", "name", "preview", "first_user_message",
        "archived", "history_mode", "project_id", "agent_nickname", "agent_role",
      ].filter((column) => columns.has(column));
      const rows = db.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM threads ORDER BY id`).all() as Record<string, unknown>[];
      const lineage = readSpawnEdges(db);
      const threads: CodexThreadRecord[] = [];
      for (const row of rows) {
        const id = String(row.id ?? "");
        if (!id) continue;
        const rolloutPath = text(row.rollout_path);
        if (rolloutPath && !(await fileExists(rolloutPath))) {
          this.#options.diagnostics.add({ code: "missing_rollout", severity: "warning", message: "Structured thread metadata points to a missing rollout.", sessionId: id, sourceKey: "state-db" });
        }
        const cwd = text(row.cwd);
        threads.push({
          id,
          title: text(row.name) ?? text(row.title),
          preview: text(row.preview) ?? text(row.first_user_message),
          cwd,
          observedCwds: cwd ? [cwd] : [],
          projectId: text(row.project_id),
          createdAtMs: timestamp(row.created_at_ms ?? row.created_at),
          updatedAtMs: timestamp(row.updated_at_ms ?? row.updated_at),
          archived: integerBoolean(row.archived),
          source: text(row.thread_source) ?? text(row.source) ?? text(row.agent_role) ?? text(row.agent_nickname),
          historyMode: text(row.history_mode),
          rolloutPaths: rolloutPath ? [rolloutPath] : [],
          sourceTier: "structured_fallback",
          partial: !cwd,
          nativeLineage: lineage.get(id),
        });
      }
      return { threads, projects: readProjects(db) };
    } finally {
      db.close();
    }
  }

  async listTurns(sessionId: string): Promise<readonly CodexTurnRecord[]> {
    if (!this.paths.historyDatabase) await this.discover();
    const path = this.paths.historyDatabase;
    if (!path) return [];
    const db = openReadOnly(path);
    try {
      if (!tableExists(db, "thread_turns") || !tableExists(db, "thread_items")) {
        this.#options.diagnostics.add({ code: "unsupported_schema", severity: "warning", message: "Native thread history tables are unavailable.", sessionId });
        return [];
      }
      const turnColumns = tableColumns(db, "thread_turns");
      if (!["thread_id", "turn_id", "rollout_ordinal", "status"].every((column) => turnColumns.has(column))) {
        this.#options.diagnostics.add({ code: "unsupported_schema", severity: "warning", message: "thread_turns is missing required identity columns.", sessionId });
        return [];
      }
      const turnRows = db.prepare("SELECT * FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal ASC").all(sessionId) as Record<string, unknown>[];
      const itemRows = db.prepare("SELECT turn_id, item_json, rollout_ordinal FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal ASC").all(sessionId) as Record<string, unknown>[];
      const itemsByTurn = new Map<string, unknown[]>();
      for (const row of itemRows) {
        const turnId = text(row.turn_id);
        if (!turnId) continue;
        try {
          const parsed: unknown = JSON.parse(String(row.item_json));
          const list = itemsByTurn.get(turnId) ?? [];
          list.push(parsed);
          itemsByTurn.set(turnId, list);
        } catch {
          this.#options.diagnostics.add({ code: "corrupt_line", severity: "warning", message: "A structured thread item contains invalid JSON.", sessionId, ordinal: number(row.rollout_ordinal) });
        }
      }
      const appServerShape = turnRows.map((row) => ({
        id: text(row.turn_id),
        status: row.error_json ? "failed" : text(row.status),
        startedAt: number(row.started_at),
        completedAt: number(row.completed_at),
        items: itemsByTurn.get(String(row.turn_id)) ?? [],
      }));
      return projectAppServerTurns(sessionId, appServerShape).map((turn, index) => ({
        ...turn,
        ordinal: number(turnRows[index]?.rollout_ordinal) ?? index + 1,
        sourceTier: "structured_fallback" as const,
      }));
    } finally {
      db.close();
    }
  }
}

function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

function newestVersioned(names: readonly string[], pattern: RegExp, directory: string): string | undefined {
  const candidates = names.flatMap((name) => {
    const match = pattern.exec(name);
    return match ? [{ name, version: Number(match[1]) }] : [];
  }).sort((a, b) => b.version - a.version);
  return candidates[0] ? join(directory, candidates[0].name) : undefined;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string }[]).map((row) => row.name));
}

function readProjects(db: DatabaseSync): CodexProjectRecord[] {
  if (!tableExists(db, "projects") || !tableExists(db, "project_roots")) return [];
  const projects = db.prepare("SELECT id, name FROM projects ORDER BY position ASC, id ASC").all() as { id: string; name: string }[];
  const roots = db.prepare("SELECT project_id, path FROM project_roots ORDER BY project_id, position ASC").all() as { project_id: string; path: string }[];
  return projects.map((project) => ({ id: project.id, name: project.name, roots: roots.filter((root) => root.project_id === project.id).map((root) => root.path) }));
}

function readSpawnEdges(db: DatabaseSync) {
  const result = new Map<string, CodexThreadRecord["nativeLineage"]>();
  if (!tableExists(db, "thread_spawn_edges")) return result;
  const rows = db.prepare("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges").all() as { parent_thread_id: string; child_thread_id: string; status: string }[];
  for (const row of rows) result.set(row.child_thread_id, {
    providerId: "codex",
    sessionId: row.child_thread_id,
    parentSessionId: row.parent_thread_id,
    kind: "subagent_spawn",
    recovery: "session_only",
  });
  return result;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed === undefined ? undefined : parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
}

function integerBoolean(value: unknown): boolean | undefined {
  return value === 1 ? true : value === 0 ? false : undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
