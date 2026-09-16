import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { isRecord } from "./internal.ts";

const REGISTRY_SCHEMA_VERSION = 1;

export interface RolloutRegistrySessionInput {
  readonly sessionId: string;
  readonly stableSegmentIdentity: string;
  readonly segmentOrder: number;
  readonly summary?: RolloutRegistrySessionSummary;
}

export interface RolloutRegistrySessionSummary {
  readonly title?: string;
  readonly preview?: string;
  readonly cwds: readonly string[];
  readonly projectId?: string;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
  readonly archived: boolean;
  readonly source?: string;
  readonly historyMode?: string;
  readonly parentSessionId?: string;
  readonly originTurnId?: string;
  readonly turnCount: number;
  readonly turnIds: readonly string[];
  readonly legacyBoundaryOrdinals: readonly number[];
}

export interface RolloutRegistryFileInput {
  readonly registryFileId: string;
  readonly canonicalPath: string;
  readonly rootKind: "active" | "archived";
  readonly stableFileIdentity: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sourceStamp: string;
  readonly contentStamp?: string;
  readonly checkpoint: {
    readonly decoderVersion: number;
    readonly observedEof: number;
    readonly committedOffset: number;
    readonly physicalLineCount: number;
    readonly headHash: string;
    readonly tailOffset: number;
    readonly tailHash: string;
    readonly identityPrefixHash?: string;
  };
  readonly sessions: readonly RolloutRegistrySessionInput[];
}

export interface RolloutRegistryFileState extends RolloutRegistryFileInput {
  readonly updatedAt: string;
}

/**
 * App-owned, rebuildable source metadata. It deliberately stores no decoded
 * records, Turn bodies, tool output, or semantic data.
 */
export class RolloutSourceRegistry {
  readonly #databasePath: string;

  constructor(databasePath: string) {
    this.#databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    const db = openDatabase(databasePath);
    db.close();
  }

  reconcile(files: readonly RolloutRegistryFileInput[]): void {
    const db = openDatabase(this.#databasePath);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const ids = files.map((file) => file.registryFileId);
        if (ids.length) {
          const placeholders = ids.map(() => "?").join(",");
          db.prepare(`DELETE FROM rollout_files WHERE registry_file_id NOT IN (${placeholders})`).run(...ids);
        } else db.exec("DELETE FROM rollout_files");

        const removePath = db.prepare("DELETE FROM rollout_files WHERE canonical_path=? AND registry_file_id<>?");
        const removeIdentity = db.prepare("DELETE FROM rollout_files WHERE stable_file_identity=? AND registry_file_id<>?");
        const upsert = db.prepare(`INSERT INTO rollout_files (
          registry_file_id, canonical_path, root_kind, stable_file_identity, size, mtime_ms,
          decoder_version, observed_eof, committed_offset, physical_line_count, head_hash,
          tail_offset, tail_hash, identity_prefix_hash, source_stamp, content_stamp, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(registry_file_id) DO UPDATE SET
          canonical_path=excluded.canonical_path, root_kind=excluded.root_kind,
          stable_file_identity=excluded.stable_file_identity, size=excluded.size,
          mtime_ms=excluded.mtime_ms, decoder_version=excluded.decoder_version,
          observed_eof=excluded.observed_eof, committed_offset=excluded.committed_offset,
          physical_line_count=excluded.physical_line_count, head_hash=excluded.head_hash,
          tail_offset=excluded.tail_offset, tail_hash=excluded.tail_hash,
          identity_prefix_hash=excluded.identity_prefix_hash, source_stamp=excluded.source_stamp,
          content_stamp=excluded.content_stamp,
          updated_at=excluded.updated_at`);
        const removeSessions = db.prepare("DELETE FROM rollout_file_sessions WHERE registry_file_id=?");
        const insertSession = db.prepare("INSERT INTO rollout_file_sessions(registry_file_id,session_id,stable_segment_identity,segment_order,summary_json) VALUES(?,?,?,?,?)");
        const now = new Date().toISOString();
        for (const file of files) {
          removePath.run(file.canonicalPath, file.registryFileId);
          removeIdentity.run(file.stableFileIdentity, file.registryFileId);
          upsert.run(
            file.registryFileId,
            file.canonicalPath,
            file.rootKind,
            file.stableFileIdentity,
            file.size,
            file.mtimeMs,
            file.checkpoint.decoderVersion,
            file.checkpoint.observedEof,
            file.checkpoint.committedOffset,
            file.checkpoint.physicalLineCount,
            file.checkpoint.headHash,
            file.checkpoint.tailOffset,
            file.checkpoint.tailHash,
            file.checkpoint.identityPrefixHash ?? "",
            file.sourceStamp,
            file.contentStamp ?? "",
            now,
          );
          removeSessions.run(file.registryFileId);
          for (const session of file.sessions) insertSession.run(file.registryFileId, session.sessionId, session.stableSegmentIdentity, session.segmentOrder, JSON.stringify(session.summary ?? {}));
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally { db.close(); }
  }

  snapshot(): readonly RolloutRegistryFileState[] {
    const db = openDatabase(this.#databasePath);
    try {
      const rows = db.prepare("SELECT * FROM rollout_files ORDER BY canonical_path").all() as unknown as FileRow[];
      const sessions = db.prepare("SELECT registry_file_id,session_id,stable_segment_identity,segment_order,summary_json FROM rollout_file_sessions ORDER BY segment_order,session_id").all() as unknown as SessionRow[];
      const byFile = new Map<string, RolloutRegistrySessionInput[]>();
      for (const session of sessions) {
        const values = byFile.get(session.registry_file_id) ?? [];
        values.push({ sessionId: session.session_id, stableSegmentIdentity: session.stable_segment_identity, segmentOrder: session.segment_order, ...(parseSummary(session.summary_json) ? { summary: parseSummary(session.summary_json) } : {}) });
        byFile.set(session.registry_file_id, values);
      }
      return rows.map((row) => ({
        registryFileId: row.registry_file_id,
        canonicalPath: row.canonical_path,
        rootKind: row.root_kind,
        stableFileIdentity: row.stable_file_identity,
        size: row.size,
        mtimeMs: row.mtime_ms,
        sourceStamp: row.source_stamp,
        ...(row.content_stamp ? { contentStamp: row.content_stamp } : {}),
        checkpoint: {
          decoderVersion: row.decoder_version,
          observedEof: row.observed_eof,
          committedOffset: row.committed_offset,
          physicalLineCount: row.physical_line_count,
          headHash: row.head_hash,
          tailOffset: row.tail_offset,
          tailHash: row.tail_hash,
          ...(row.identity_prefix_hash ? { identityPrefixHash: row.identity_prefix_hash } : {}),
        },
        sessions: byFile.get(row.registry_file_id) ?? [],
        updatedAt: row.updated_at,
      }));
    } finally { db.close(); }
  }
}

// SQLite result codes: SQLITE_CORRUPT=11, SQLITE_SCHEMA=17, SQLITE_NOTADB=26.
// I/O codes such as SQLITE_FULL, SQLITE_CANTOPEN, and SQLITE_READONLY are not recoverable cache corruption.
const REGISTRY_RECOVERY_ERROR_CODES = new Set([11, 17, 26]);
const MAX_QUARANTINED_REGISTRIES = 3;

function openDatabase(databasePath: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath);
    configure(db);
    ensureSchema(db);
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* The failed handle may already be closed. */ }
    if (!isRecoverableRegistryError(error)) throw error;
    quarantine(databasePath);
    const rebuilt = new DatabaseSync(databasePath);
    try {
      configure(rebuilt);
      ensureSchema(rebuilt);
      return rebuilt;
    } catch (rebuildError) {
      try { rebuilt.close(); } catch { /* Preserve the rebuild error. */ }
      throw rebuildError;
    }
  }
}

function isRecoverableRegistryError(error: unknown): boolean {
  if (error instanceof RegistrySchemaError) return true;
  if (!isRecord(error) || error.code !== "ERR_SQLITE_ERROR") return false;
  return typeof error.errcode === "number" && REGISTRY_RECOVERY_ERROR_CODES.has(error.errcode & 0xff);
}

function quarantine(databasePath: string): void {
  const stamp = String(Date.now());
  const quarantineBase = `${databasePath}.corrupt-${stamp}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${databasePath}${suffix}`;
    if (existsSync(source)) renameSync(source, `${quarantineBase}${suffix}`);
  }
  pruneQuarantined(databasePath);
}

function pruneQuarantined(databasePath: string): void {
  const directory = dirname(databasePath);
  const prefix = `${basename(databasePath)}.corrupt-`;
  const stems = [...new Set(readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.endsWith("-wal") || name.endsWith("-shm") ? name.slice(0, -4) : name))]
    .sort()
    .reverse();
  for (const stem of stems.slice(MAX_QUARANTINED_REGISTRIES)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = join(directory, `${stem}${suffix}`);
      if (existsSync(path)) unlinkSync(path);
    }
  }
}

class RegistrySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrySchemaError";
  }
}

function configure(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
}

function ensureSchema(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  assertColumns(db, "registry_meta", ["key", "value"]);
  const current = db.prepare("SELECT value FROM registry_meta WHERE key='schema_version'").get() as { value: string } | undefined;
  if (current && Number(current.value) !== REGISTRY_SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS rollout_file_sessions; DROP TABLE IF EXISTS rollout_files; DELETE FROM registry_meta WHERE key='schema_version'");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS rollout_files (
      registry_file_id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      root_kind TEXT NOT NULL CHECK(root_kind IN ('active','archived')),
      stable_file_identity TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      decoder_version INTEGER NOT NULL,
      observed_eof INTEGER NOT NULL,
      committed_offset INTEGER NOT NULL,
      physical_line_count INTEGER NOT NULL,
      head_hash TEXT NOT NULL,
      tail_offset INTEGER NOT NULL,
      tail_hash TEXT NOT NULL,
      identity_prefix_hash TEXT NOT NULL DEFAULT '',
      source_stamp TEXT NOT NULL,
      content_stamp TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, "rollout_files", "content_stamp", "TEXT NOT NULL DEFAULT ''");
  assertColumns(db, "rollout_files", [
    "registry_file_id", "canonical_path", "root_kind", "stable_file_identity", "size", "mtime_ms", "decoder_version",
    "observed_eof", "committed_offset", "physical_line_count", "head_hash", "tail_offset", "tail_hash",
    "identity_prefix_hash", "source_stamp", "content_stamp", "updated_at",
  ]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rollout_file_sessions (
      registry_file_id TEXT NOT NULL REFERENCES rollout_files(registry_file_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      stable_segment_identity TEXT NOT NULL,
      segment_order INTEGER NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(registry_file_id,session_id)
    );
  `);
  ensureColumn(db, "rollout_file_sessions", "summary_json", "TEXT NOT NULL DEFAULT '{}'");
  assertColumns(db, "rollout_file_sessions", ["registry_file_id", "session_id", "stable_segment_identity", "segment_order", "summary_json"]);
  db.exec("CREATE INDEX IF NOT EXISTS rollout_files_root ON rollout_files(root_kind); CREATE INDEX IF NOT EXISTS rollout_file_sessions_session ON rollout_file_sessions(session_id);");
  db.prepare("INSERT INTO registry_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(REGISTRY_SCHEMA_VERSION));
}

function assertColumns(db: DatabaseSync, table: string, required: readonly string[]): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
  const names = new Set(columns.map((column) => column.name).filter((name): name is string => typeof name === "string"));
  const missing = required.filter((name) => !names.has(name));
  if (missing.length) throw new RegistrySchemaError(`Registry table ${table} is missing required columns.`);
}

interface FileRow {
  registry_file_id: string;
  canonical_path: string;
  root_kind: "active" | "archived";
  stable_file_identity: string;
  size: number;
  mtime_ms: number;
  decoder_version: number;
  observed_eof: number;
  committed_offset: number;
  physical_line_count: number;
  head_hash: string;
  tail_offset: number;
  tail_hash: string;
  identity_prefix_hash: string;
  source_stamp: string;
  content_stamp?: string;
  updated_at: string;
}

interface SessionRow { registry_file_id: string; session_id: string; stable_segment_identity: string; segment_order: number; summary_json?: unknown }

function parseSummary(raw: unknown): RolloutRegistrySessionInput["summary"] {
  if (typeof raw !== "string" || !raw || raw === "{}") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) && Array.isArray(value.cwds) && Array.isArray(value.turnIds) && Array.isArray(value.legacyBoundaryOrdinals) && typeof value.archived === "boolean" && typeof value.turnCount === "number" ? value as RolloutRegistrySessionSummary : undefined;
  } catch { return undefined; }
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
