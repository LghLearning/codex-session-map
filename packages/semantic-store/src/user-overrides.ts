import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Session } from "../../core/src/index.ts";
import { validateSemanticEdge, type SemanticParentRelation } from "./semantic-parent.ts";

export type UserField = "title" | "label" | "parent";
export interface UserKey { providerId: string; sessionId: string; field: UserField; nativeTurnId?: string }
export interface UserValue {
  title?: string;
  label?: string;
  relation?: SemanticParentRelation;
  parentSessionId?: string;
  feedback?: { verdict: "accepted" | "edited" | "rejected"; aiOriginalText: string; editedText?: string; sourceFingerprint: string; reviewedAt: string };
}
export interface UserOverride extends UserKey { workspace: string; value: UserValue | null; revision: number; updatedAt: string }
export interface UserEdit extends UserKey { id: string; workspace: string; before: UserValue | null; after: UserValue | null; revision: number; timestamp: string }
export class UserEditError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Shares the existing semantic database; never manufactures an AI suggestion row. */
export class UserOverrides {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) { this.#db = db; }

  read(key: UserKey): UserOverride | undefined {
    const row = this.#db.prepare("SELECT * FROM user_overrides WHERE provider_id=? AND session_id=? AND native_turn_id=? AND field=?")
      .get(key.providerId, key.sessionId, key.nativeTurnId ?? "", key.field) as any;
    return row ? { ...key, workspace: row.workspace, value: JSON.parse(row.value_json), revision: row.revision, updatedAt: row.updated_at } : undefined;
  }

  list(providerId: string, field: UserField, sessionId?: string): UserOverride[] {
    const rows = this.#db.prepare("SELECT * FROM user_overrides WHERE provider_id=? AND field=? AND (? IS NULL OR session_id=?)")
      .all(providerId, field, sessionId ?? null, sessionId ?? null) as any[];
    return rows.map((row) => this.read({ providerId, sessionId: row.session_id, nativeTurnId: row.native_turn_id || undefined, field })!);
  }

  write(key: UserKey, workspace: string, value: UserValue | null, expectedRevision?: number, sessions?: readonly Session[]): UserEdit {
    return this.#transaction(() => {
      const previous = this.read(key);
      if (expectedRevision !== undefined && expectedRevision !== (previous?.revision ?? 0)) throw new UserEditError("This item changed again. Reload before editing.", 409);
      if (key.field === "parent" && sessions) this.validateParent(key, value, sessions);
      return this.#save(key, workspace, value, previous);
    });
  }

  latest(workspace: string): UserEdit | undefined {
    const row = this.#db.prepare("SELECT * FROM user_edit_history WHERE workspace=? AND undone=0 ORDER BY rowid DESC LIMIT 1").get(workspace) as any;
    return row ? this.#editRow(row) : undefined;
  }

  history(id: string): UserEdit | undefined {
    const row = this.#db.prepare("SELECT * FROM user_edit_history WHERE id=?").get(id) as any;
    return row ? this.#editRow(row) : undefined;
  }

  undo(id: string, expectedRevision: number, workspace: string, sessions: readonly Session[]): UserEdit {
    return this.#transaction(() => {
      const row = this.#db.prepare("SELECT * FROM user_edit_history WHERE id=?").get(id) as any;
      if (!row || row.workspace !== workspace) throw new UserEditError("Manual change not found.", 404);
      const edit = this.#editRow(row);
      const current = this.read(edit);
      if (row.undone || edit.revision !== expectedRevision || current?.revision !== expectedRevision) {
        throw new UserEditError("Undo unavailable because this item changed again.", 409);
      }
      if (edit.field === "parent") this.validateParent(edit, edit.before, sessions);
      const result = this.#save(edit, workspace, edit.before, current, false);
      this.#db.prepare("UPDATE user_edit_history SET undone=1 WHERE id=?").run(id);
      return result;
    });
  }

  validateParent(key: UserKey, value: UserValue | null, sessions: readonly Session[]): void {
    const generated = this.#db.prepare("SELECT generated_relation, generated_parent_session_id FROM session_semantic_edges WHERE provider_id=? AND child_session_id=?")
      .get(key.providerId, key.sessionId) as any;
    const relation = value?.relation ?? generated?.generated_relation;
    const parentId = value?.relation ? value.parentSessionId : generated?.generated_parent_session_id ?? undefined;
    if (!relation) return; // Restoring an item with no AI suggestion means Unorganized.
    try { validateSemanticEdge(key.sessionId, parentId, relation, sessions); }
    catch (error) { throw new UserEditError((error as Error).message); }
    if (relation === "root") return;
    const parents = new Map<string, string | undefined>();
    const rows = this.#db.prepare("SELECT child_session_id, generated_parent_session_id FROM session_semantic_edges WHERE provider_id=?").all(key.providerId) as any[];
    for (const row of rows) parents.set(row.child_session_id, row.generated_parent_session_id ?? undefined);
    for (const override of this.list(key.providerId, "parent")) if (override.value?.relation) parents.set(override.sessionId, override.value.parentSessionId);
    parents.set(key.sessionId, parentId);
    const seen = new Set<string>();
    let current: string | undefined = key.sessionId;
    while (current) {
      if (seen.has(current)) throw new UserEditError("This parent would create a cycle.");
      seen.add(current);
      current = parents.get(current);
    }
  }

  manualCandidates(session: Session, sessions: readonly Session[], query = "") {
    const key: UserKey = { providerId: session.providerId, sessionId: session.providerSessionId, field: "parent" };
    return sessions.flatMap((candidate) => {
      try { this.validateParent(key, { relation: "continuation", parentSessionId: candidate.providerSessionId }, sessions); }
      catch { return []; }
      const override = this.read({ ...key, sessionId: candidate.providerSessionId, field: "title" });
      const generated = this.#db.prepare("SELECT generated_title FROM session_semantic_titles WHERE provider_id=? AND session_id=?").get(candidate.providerId, candidate.providerSessionId) as any;
      const title = override?.value?.title ?? generated?.generated_title ?? candidate.title;
      return `${title} ${candidate.title}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        ? [{ sessionId: candidate.providerSessionId, title, createdAt: candidate.createdAt }] : [];
    });
  }

  #save(key: UserKey, workspace: string, value: UserValue | null, previous?: UserOverride, record = true): UserEdit {
    const edit: UserEdit = { ...key, id: randomUUID(), workspace, before: previous?.value ?? null, after: value, revision: (previous?.revision ?? 0) + 1, timestamp: new Date().toISOString() };
    this.#db.prepare(`INSERT INTO user_overrides (provider_id,session_id,native_turn_id,field,workspace,value_json,revision,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(provider_id,session_id,native_turn_id,field) DO UPDATE SET
      workspace=excluded.workspace,value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(key.providerId, key.sessionId, key.nativeTurnId ?? "", key.field, workspace, JSON.stringify(value), edit.revision, edit.timestamp);
    if (record) this.#db.prepare(`INSERT INTO user_edit_history (id,provider_id,workspace,session_id,native_turn_id,field,before_json,after_json,revision,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(edit.id, key.providerId, workspace, key.sessionId, key.nativeTurnId ?? "", key.field, JSON.stringify(edit.before), JSON.stringify(value), edit.revision, edit.timestamp);
    return edit;
  }

  #editRow(row: any): UserEdit {
    return { id: row.id, providerId: row.provider_id, workspace: row.workspace, sessionId: row.session_id, nativeTurnId: row.native_turn_id || undefined, field: row.field, before: JSON.parse(row.before_json), after: JSON.parse(row.after_json), revision: row.revision, timestamp: row.created_at };
  }
  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.#db.exec("COMMIT"); return value; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
}

/** Called within the store migration transaction. Legacy rows remain available for audit. */
export function migrateUserOverrides(db: DatabaseSync): void {
  db.exec(`CREATE TABLE user_overrides (
    provider_id TEXT NOT NULL, session_id TEXT NOT NULL, native_turn_id TEXT NOT NULL DEFAULT '',
    field TEXT NOT NULL CHECK(field IN ('title','label','parent')), workspace TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK(json_valid(value_json)), revision INTEGER NOT NULL CHECK(revision>0), updated_at TEXT NOT NULL,
    PRIMARY KEY(provider_id,session_id,native_turn_id,field));
    CREATE TABLE user_edit_history (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, workspace TEXT NOT NULL, session_id TEXT NOT NULL,
    native_turn_id TEXT NOT NULL DEFAULT '', field TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
    revision INTEGER NOT NULL, created_at TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX user_edit_history_workspace ON user_edit_history(workspace,created_at);`);
  const expected: { provider: string; session: string; turn: string; field: UserField; json: string; time: string }[] = [];
  const titles = db.prepare("SELECT * FROM session_semantic_titles WHERE user_title IS NOT NULL").all() as any[];
  for (const row of titles) expected.push({ provider: row.provider_id, session: row.session_id, turn: "", field: "title", json: JSON.stringify({ title: row.user_title }), time: row.user_edited_at ?? row.generated_at });
  const parents = db.prepare("SELECT * FROM session_semantic_edges WHERE user_relation IS NOT NULL").all() as any[];
  for (const row of parents) expected.push({ provider: row.provider_id, session: row.child_session_id, turn: "", field: "parent", json: JSON.stringify({ relation: row.user_relation, parentSessionId: row.user_parent_session_id ?? undefined }), time: row.user_reviewed_at ?? row.generated_at });
  const feedback = db.prepare("SELECT * FROM turn_semantic_trace_feedback").all() as any[];
  for (const row of feedback) expected.push({ provider: row.provider_id, session: row.session_id, turn: row.native_turn_id, field: "label", json: JSON.stringify({
    label: row.verdict === "edited" ? row.edited_text : undefined,
    feedback: { verdict: row.verdict, aiOriginalText: row.ai_original_text, editedText: row.edited_text ?? undefined, sourceFingerprint: row.source_fingerprint, reviewedAt: row.reviewed_at },
  }), time: row.reviewed_at });
  const insert = db.prepare("INSERT INTO user_overrides VALUES (?,?,?,?,?,?,1,?)");
  for (const row of expected) insert.run(row.provider, row.session, row.turn, row.field, "", row.json, row.time);
  const count = Number(db.prepare("SELECT count(*) AS n FROM user_overrides").get()!.n);
  if (count !== expected.length) throw new Error("User override migration row count mismatch");
  for (const row of expected) {
    const actual = db.prepare("SELECT value_json FROM user_overrides WHERE provider_id=? AND session_id=? AND native_turn_id=? AND field=?").get(row.provider, row.session, row.turn, row.field);
    if (actual?.value_json !== row.json) throw new Error("User override migration value mismatch");
  }
}
