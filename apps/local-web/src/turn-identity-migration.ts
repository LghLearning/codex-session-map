import { copyFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TurnIdentityAlias } from "../../../packages/codex-adapter/src/turn-identity.ts";
import { SqliteSemanticTraceStore, type TurnIdentityMigration } from "../../../packages/semantic-store/src/index.ts";
import { migrateOrganizationTurnReferences } from "../../../packages/organizer/src/repository.ts";

interface MigrationOptions {
  readonly semanticPath: string;
  readonly organizationPath: string;
  readonly searchPath: string;
}

interface BackupSet {
  readonly directory: string;
  readonly files: readonly { original: string; backup: string }[];
}

/**
 * Migrates app-owned references before any store connection is opened. The
 * backup is the rollback boundary; an old binary alone cannot interpret v2 IDs.
 */
export async function migrateTurnIdentityStores(options: readonly string[], aliases: readonly TurnIdentityAlias[]): Promise<void> {
  const paths = migrationPaths(options);
  const compatibilityAliases = [...aliases, ...recoverAliasesFromPersistentReferences(paths, aliases)];
  const mappings = toMigrations(compatibilityAliases);
  if (!mappings.length) return;
  // Every current rollout gets a compatibility alias. Only perform the
  // durable migration when an app-owned store actually contains an old key.
  // This keeps normal v2 startups read-only and avoids needless backups.
  if (!hasPersistentLegacyReferences(paths, mappings)) return;
  const backup = await backupDatabases(paths);
  try {
    const semantic = await migrateSemantic(paths.semanticPath, mappings);
    const organization = migrateOrganizationTurnReferences(paths.organizationPath, mappings);
    invalidateSearch(paths.searchPath, mappings);
    if (semantic.tracesMoved || semantic.feedbackMoved || semantic.overridesMoved || semantic.historyMoved || semantic.anchorsMoved || organization) {
      console.warn(`Migrated ${mappings.length} recovered Turn identities. App-owned backup: ${backup.directory}`);
    }
  } catch (error) {
    await restoreBackup(backup);
    throw new Error(`Recovered Turn identity migration failed; app-owned databases were restored from ${backup.directory}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function migrationPaths(options: readonly string[]): MigrationOptions {
  const valueAfter = (flag: string, fallback: string): string => {
    const index = options.indexOf(flag);
    return index >= 0 && options[index + 1] ? resolve(options[index + 1]!) : resolve(fallback);
  };
  return {
    semanticPath: valueAfter("--semantic-store", ".codex-session-map/semantic-traces.sqlite"),
    organizationPath: valueAfter("--organization-store", ".codex-session-map/organization.sqlite"),
    searchPath: valueAfter("--search-index", ".codex-session-map/search.sqlite"),
  };
}

function toMigrations(aliases: readonly TurnIdentityAlias[]): TurnIdentityMigration[] {
  const unique = new Map<string, TurnIdentityMigration>();
  for (const alias of aliases) {
    if (alias.oldNativeTurnId === alias.newNativeTurnId) continue;
    const key = `${alias.providerId}\0${alias.sessionId}\0${alias.oldNativeTurnId}`;
    const previous = unique.get(key);
    if (previous && previous.newNativeTurnId !== alias.newNativeTurnId) throw new Error(`Recovered Turn identity is ambiguous for ${alias.sessionId}.`);
    unique.set(key, alias);
  }
  return [...unique.values()];
}

/**
 * A pre-v2 ID includes the old path hash, which is unavailable after an
 * archive/rename. Its final component is still the source boundary ordinal, so an
 * app-owned legacy reference can be paired with the current path-independent
 * identity without making the old path a new source of truth.
 */
function recoverAliasesFromPersistentReferences(paths: MigrationOptions, aliases: readonly TurnIdentityAlias[]): TurnIdentityAlias[] {
  const byOrdinal = new Map<string, TurnIdentityAlias[]>();
  for (const alias of aliases) if (alias.boundaryRecordOrdinal !== undefined) {
    const key = `${alias.sessionId}\0${alias.boundaryRecordOrdinal}`;
    const values = byOrdinal.get(key) ?? [];
    values.push(alias);
    byOrdinal.set(key, values);
  }
  const recovered: TurnIdentityAlias[] = [];
  for (const reference of listPersistentLegacyReferences(paths)) {
    const ordinal = legacyOrdinal(reference.oldNativeTurnId);
    if (ordinal === undefined) continue;
    const candidates = [...new Map((byOrdinal.get(`${reference.sessionId}\0${ordinal}`) ?? []).map((alias) => [alias.newNativeTurnId, alias])).values()];
    if (candidates.length > 1) throw new Error(`Recovered Turn identity is ambiguous for ${reference.sessionId} ordinal ${ordinal}.`);
    const current = candidates[0];
    if (current) recovered.push({ ...current, oldNativeTurnId: reference.oldNativeTurnId });
  }
  return recovered;
}

function legacyOrdinal(value: string): number | undefined {
  if (!value.startsWith("recovered:") || value.startsWith("recovered:v2:")) return undefined;
  const match = /^recovered:[^:]+:(\d+)$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

function listPersistentLegacyReferences(paths: MigrationOptions): { sessionId: string; oldNativeTurnId: string }[] {
  const references = new Map<string, { sessionId: string; oldNativeTurnId: string }>();
  const add = (sessionId: unknown, nativeTurnId: unknown) => {
    if (typeof sessionId !== "string" || typeof nativeTurnId !== "string" || legacyOrdinal(nativeTurnId) === undefined) return;
    references.set(`${sessionId}\0${nativeTurnId}`, { sessionId, oldNativeTurnId: nativeTurnId });
  };
  if (existsSync(paths.semanticPath)) {
    const db = new DatabaseSync(paths.semanticPath);
    try {
      const has = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
      for (const table of ["turn_semantic_traces", "turn_semantic_trace_feedback"] as const) {
        if (!has(table)) continue;
        for (const row of db.prepare(`SELECT session_id,native_turn_id FROM ${table}`).all() as { session_id: string; native_turn_id: string }[]) add(row.session_id, row.native_turn_id);
      }
      if (has("user_overrides")) {
        for (const row of db.prepare("SELECT session_id,native_turn_id,value_json FROM user_overrides WHERE field='label' OR field='parent'").all() as { session_id: string; native_turn_id: string; value_json: string }[]) {
          add(row.session_id, row.native_turn_id);
          addParentAnchor(row.value_json, add);
        }
      }
      if (has("user_edit_history")) for (const row of db.prepare("SELECT session_id,native_turn_id,before_json,after_json FROM user_edit_history WHERE field='label' OR field='parent'").all() as { session_id: string; native_turn_id: string; before_json: string; after_json: string }[]) {
        add(row.session_id, row.native_turn_id);
        addParentAnchor(row.before_json, add);
        addParentAnchor(row.after_json, add);
      }
    } finally { db.close(); }
  }
  if (existsSync(paths.searchPath)) {
    const db = new DatabaseSync(paths.searchPath);
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_documents'").get()) {
        for (const row of db.prepare("SELECT session_id,native_turn_id FROM search_documents WHERE native_turn_id IS NOT NULL").all() as { session_id: string; native_turn_id: string }[]) add(row.session_id, row.native_turn_id);
      }
    } finally { db.close(); }
  }
  if (existsSync(paths.organizationPath)) {
    const db = new DatabaseSync(paths.organizationPath);
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_items'").get()) {
        for (const row of db.prepare("SELECT session_id,native_turn_id FROM organization_items WHERE native_turn_id IS NOT NULL").all() as { session_id: string; native_turn_id: string }[]) add(row.session_id, row.native_turn_id);
      }
    } finally { db.close(); }
  }
  return [...references.values()];
}

function addParentAnchor(raw: string, add: (sessionId: unknown, nativeTurnId: unknown) => void): void {
  try {
    const value = JSON.parse(raw) as { parentSessionId?: string; anchorTurnId?: string } | null;
    if (value) add(value.parentSessionId, value.anchorTurnId);
  } catch { /* malformed app-owned JSON is handled by the transactional migration */ }
}

async function migrateSemantic(path: string, mappings: readonly TurnIdentityMigration[]) {
  if (!existsSync(path)) return { tracesMoved: 0, feedbackMoved: 0, overridesMoved: 0, historyMoved: 0, anchorsMoved: 0 };
  const store = new SqliteSemanticTraceStore(path);
  try { return await store.migrateTurnIdentityReferences(mappings); }
  finally { await store.close(); }
}

function invalidateSearch(path: string, mappings: readonly TurnIdentityMigration[]): void {
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path);
  try {
    const hasDocuments = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_documents'").get());
    if (!hasDocuments) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      const deleteFts = db.prepare("DELETE FROM search_documents_fts WHERE doc_id=?");
      const deleteDocument = db.prepare("DELETE FROM search_documents WHERE workspace_id=? AND session_id=? AND native_turn_id=?");
      const deleteState = db.prepare("DELETE FROM search_session_state WHERE session_id=?");
      for (const mapping of mappings) {
        const rows = db.prepare("SELECT workspace_id,doc_id FROM search_documents WHERE session_id=? AND native_turn_id=?").all(mapping.sessionId, mapping.oldNativeTurnId) as { workspace_id: string; doc_id: string }[];
        for (const row of rows) deleteFts.run(row.doc_id);
        for (const row of rows) deleteDocument.run(row.workspace_id, mapping.sessionId, mapping.oldNativeTurnId);
        if (rows.length) deleteState.run(mapping.sessionId);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

function hasPersistentLegacyReferences(paths: MigrationOptions, mappings: readonly TurnIdentityMigration[]): boolean {
  return hasSemanticLegacyReferences(paths.semanticPath, mappings)
    || hasOrganizationLegacyReferences(paths.organizationPath, mappings)
    || hasSearchLegacyReferences(paths.searchPath, mappings);
}

function hasSemanticLegacyReferences(path: string, mappings: readonly TurnIdentityMigration[]): boolean {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path);
  try {
    const has = (table: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const turnTables = ["turn_semantic_traces", "turn_semantic_trace_feedback"] as const;
    for (const table of turnTables) {
      if (!has(table)) continue;
      const find = db.prepare(`SELECT 1 FROM ${table} WHERE provider_id=? AND session_id=? AND native_turn_id=? LIMIT 1`);
      for (const mapping of mappings) if (find.get(mapping.providerId, mapping.sessionId, mapping.oldNativeTurnId)) return true;
    }
    if (has("user_overrides")) {
      const findTurn = db.prepare("SELECT 1 FROM user_overrides WHERE provider_id=? AND session_id=? AND native_turn_id=? LIMIT 1");
      const parentRows = db.prepare("SELECT value_json FROM user_overrides WHERE field='parent'").all() as { value_json: string }[];
      for (const mapping of mappings) {
        if (findTurn.get(mapping.providerId, mapping.sessionId, mapping.oldNativeTurnId)) return true;
        if (parentRows.some((row) => hasAnchor(row.value_json, mapping))) return true;
      }
    }
    if (has("user_edit_history")) {
      const findTurn = db.prepare("SELECT 1 FROM user_edit_history WHERE provider_id=? AND session_id=? AND native_turn_id=? LIMIT 1");
      const parentRows = db.prepare("SELECT before_json,after_json FROM user_edit_history WHERE field='parent'").all() as { before_json: string; after_json: string }[];
      for (const mapping of mappings) {
        if (findTurn.get(mapping.providerId, mapping.sessionId, mapping.oldNativeTurnId)) return true;
        if (parentRows.some((row) => hasAnchor(row.before_json, mapping) || hasAnchor(row.after_json, mapping))) return true;
      }
    }
    return false;
  } finally { db.close(); }
}

function hasAnchor(valueJson: string, mapping: TurnIdentityMigration): boolean {
  try {
    const value = JSON.parse(valueJson) as { parentSessionId?: string; anchorTurnId?: string } | null;
    return value?.parentSessionId === mapping.sessionId && value.anchorTurnId === mapping.oldNativeTurnId;
  } catch { return false; }
}

function hasOrganizationLegacyReferences(path: string, mappings: readonly TurnIdentityMigration[]): boolean {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_items'").get()) return false;
    const find = db.prepare("SELECT 1 FROM organization_items WHERE session_id=? AND native_turn_id=? LIMIT 1");
    return mappings.some((mapping) => Boolean(find.get(mapping.sessionId, mapping.oldNativeTurnId)));
  } finally { db.close(); }
}

function hasSearchLegacyReferences(path: string, mappings: readonly TurnIdentityMigration[]): boolean {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_documents'").get()) return false;
    const find = db.prepare("SELECT 1 FROM search_documents WHERE session_id=? AND native_turn_id=? LIMIT 1");
    return mappings.some((mapping) => Boolean(find.get(mapping.sessionId, mapping.oldNativeTurnId)));
  } finally { db.close(); }
}

async function backupDatabases(paths: MigrationOptions): Promise<BackupSet> {
  const directory = join(dirname(paths.semanticPath), "turn-identity-backups", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(directory, { recursive: true });
  const files: { original: string; backup: string }[] = [];
  for (const original of [paths.semanticPath, paths.organizationPath, paths.searchPath]) {
    if (!existsSync(original)) continue;
    checkpointWal(original);
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${original}${suffix}`;
      if (!existsSync(source)) continue;
      const backup = join(directory, `${basename(original)}${suffix}`);
      await copyFile(source, backup);
      files.push({ original: source, backup });
    }
  }
  return { directory, files };
}

function checkpointWal(path: string): void {
  const db = new DatabaseSync(path);
  try { db.exec("PRAGMA wal_checkpoint(FULL)"); }
  finally { db.close(); }
}

async function restoreBackup(backup: BackupSet): Promise<void> {
  const backedUp = new Set(backup.files.map((file) => file.original));
  const originals = new Set(backup.files.map((file) => file.original.replace(/-(?:wal|shm)$/, "")));
  for (const original of originals) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = `${original}${suffix}`;
      if (!backedUp.has(path) && existsSync(path)) await rm(path, { force: true });
    }
  }
  for (const file of backup.files) await copyFile(file.backup, file.original);
}
