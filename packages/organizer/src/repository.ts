import { DatabaseSync } from "node:sqlite";
import type { OrganizationCounts, OrganizationItem, OrganizationItemStatus, OrganizationJob, OrganizationJobStatus, OrganizationMetricDelta, OrganizationMode, OrganizationOperation, OrganizationRequest } from "./types.ts";

export class OrganizationRepository {
  readonly #db: DatabaseSync;

  constructor(databasePath = ":memory:") {
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS organization_jobs (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mode TEXT NOT NULL,
        session_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
        started_at TEXT, updated_at TEXT NOT NULL, completed_at TEXT,
        requested_by TEXT NOT NULL, run_token INTEGER NOT NULL DEFAULT 0, error TEXT,
        reused_trace INTEGER NOT NULL DEFAULT 0, reused_title INTEGER NOT NULL DEFAULT 0, reused_parent INTEGER NOT NULL DEFAULT 0,
        planning_ms REAL NOT NULL DEFAULT 0, snapshot_preparation_ms REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS organization_jobs_workspace ON organization_jobs(workspace_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS organization_items (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES organization_jobs(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, native_turn_id TEXT,
        entity_type TEXT NOT NULL, operation TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
        strategy_version TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        error_code TEXT, error TEXT, started_at TEXT, completed_at TEXT,
        queue_ms REAL NOT NULL DEFAULT 0, input_chars INTEGER NOT NULL DEFAULT 0,
        model_ms REAL NOT NULL DEFAULT 0, validation_ms REAL NOT NULL DEFAULT 0,
        commit_ms REAL NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(job_id, operation, session_id, native_turn_id)
      );
      CREATE INDEX IF NOT EXISTS organization_items_job ON organization_items(job_id, operation, status);
      CREATE INDEX IF NOT EXISTS organization_items_dedupe ON organization_items(workspace_id, operation, session_id, native_turn_id, source_fingerprint, strategy_version, status);
    `);
    this.#ensureReuseColumns();
    this.#ensureMetricColumns();
    this.interruptActiveJobs();
  }

  createJob(id: string, request: OrganizationRequest, items: readonly Omit<OrganizationItem, "jobId" | "status" | "attempts" | "metrics">[], now: string, reused: Readonly<Record<OrganizationOperation, number>> = { trace: 0, title: 0, parent: 0 }, timing: { planningMs?: number; snapshotPreparationMs?: number } = {}): OrganizationJob {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`INSERT INTO organization_jobs(id,workspace_id,mode,session_id,status,created_at,updated_at,requested_by,reused_trace,reused_title,reused_parent,planning_ms,snapshot_preparation_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, request.workspaceId, request.mode, request.sessionId ?? null, "queued", now, now, request.requestedBy ?? "user", reused.trace, reused.title, reused.parent, timing.planningMs ?? 0, timing.snapshotPreparationMs ?? 0);
      const insert = this.#db.prepare(`INSERT INTO organization_items(id,job_id,workspace_id,session_id,native_turn_id,entity_type,operation,source_fingerprint,strategy_version,status)
        VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const item of items) insert.run(item.id, id, item.workspaceId, item.sessionId, item.nativeTurnId ?? null, item.entityType, item.operation, item.sourceFingerprint, item.strategyVersion, "queued");
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    return this.getJob(id)!;
  }

  getJob(id: string): OrganizationJob | undefined {
    const row = this.#db.prepare("SELECT * FROM organization_jobs WHERE id=?").get(id) as JobRow | undefined;
    return row ? this.#projectJob(row) : undefined;
  }

  latest(workspaceId: string): OrganizationJob | undefined {
    const row = this.#db.prepare("SELECT * FROM organization_jobs WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 1").get(workspaceId) as JobRow | undefined;
    return row ? this.#projectJob(row) : undefined;
  }

  active(workspaceId: string): OrganizationJob | undefined {
    const row = this.#db.prepare("SELECT * FROM organization_jobs WHERE workspace_id=? AND status IN ('queued','running','pausing','paused','canceling','interrupted') ORDER BY updated_at DESC LIMIT 1").get(workspaceId) as JobRow | undefined;
    return row ? this.#projectJob(row) : undefined;
  }

  listItems(jobId: string): OrganizationItem[] {
    return (this.#db.prepare("SELECT * FROM organization_items WHERE job_id=? ORDER BY CASE operation WHEN 'trace' THEN 0 WHEN 'title' THEN 1 ELSE 2 END, rowid").all(jobId) as unknown as ItemRow[]).map(projectItem);
  }

  nextQueued(jobId: string): OrganizationItem | undefined {
    const row = this.#db.prepare("SELECT * FROM organization_items WHERE job_id=? AND status='queued' ORDER BY CASE operation WHEN 'trace' THEN 0 WHEN 'title' THEN 1 ELSE 2 END, rowid LIMIT 1").get(jobId) as ItemRow | undefined;
    return row ? projectItem(row) : undefined;
  }

  updateJob(id: string, status: OrganizationJobStatus, now: string, options: { error?: string; incrementToken?: boolean } = {}): OrganizationJob {
    this.#db.prepare(`UPDATE organization_jobs SET status=?, updated_at=?, started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END,
      completed_at=CASE WHEN ? IN ('completed','completed_with_failures','canceled','failed') THEN ? ELSE completed_at END,
      run_token=run_token+?, error=? WHERE id=?`).run(status, now, status, now, status, now, options.incrementToken ? 1 : 0, options.error ?? null, id);
    const job = this.getJob(id);
    if (!job) throw new Error("Organization job was not found.");
    return job;
  }

  updateItem(id: string, status: OrganizationItemStatus, now: string, options: { errorCode?: string; error?: string; incrementAttempts?: boolean; sourceFingerprint?: string; strategyVersion?: string } = {}): void {
    this.#db.prepare(`UPDATE organization_items SET status=?, attempts=attempts+?,
      started_at=CASE WHEN ?='running' THEN ? ELSE started_at END,
      completed_at=CASE WHEN ? IN ('success','failed','canceled','stale','reused') THEN ? ELSE NULL END,
      error_code=?, error=?, source_fingerprint=COALESCE(?,source_fingerprint), strategy_version=COALESCE(?,strategy_version) WHERE id=?`)
      .run(status, options.incrementAttempts ? 1 : 0, status, now, status, now, options.errorCode ?? null, options.error ?? null, options.sourceFingerprint ?? null, options.strategyVersion ?? null, id);
    this.#touchItemJob(id, now);
  }

  addItemMetrics(id: string, metrics: OrganizationMetricDelta): void {
    this.#db.prepare(`UPDATE organization_items SET queue_ms=queue_ms+?, input_chars=input_chars+?, model_ms=model_ms+?,
      validation_ms=validation_ms+?, commit_ms=commit_ms+?, retry_count=retry_count+? WHERE id=?`)
      .run(metrics.queueMs ?? 0, metrics.inputChars ?? 0, metrics.modelMs ?? 0, metrics.validationMs ?? 0, metrics.commitMs ?? 0, metrics.retryCount ?? 0, id);
  }

  addSnapshotPreparation(id: string, durationMs: number): void {
    this.#db.prepare("UPDATE organization_jobs SET snapshot_preparation_ms=snapshot_preparation_ms+? WHERE id=?").run(durationMs, id);
  }

  resetRetryable(jobId: string, now: string): void {
    this.#db.prepare("UPDATE organization_items SET status='queued', error_code=NULL, error=NULL, started_at=NULL, completed_at=NULL WHERE job_id=? AND status IN ('failed','stale','canceled')").run(jobId);
    this.#db.prepare("UPDATE organization_jobs SET status='queued', updated_at=?, completed_at=NULL, error=NULL, run_token=run_token+1 WHERE id=?").run(now, jobId);
  }

  cancelPending(jobId: string, now: string): void {
    this.#db.prepare("UPDATE organization_items SET status='canceled', error_code='canceled', error='Canceled by user.', completed_at=? WHERE job_id=? AND status IN ('queued','stale')").run(now, jobId);
  }

  interruptActiveJobs(): void {
    const now = new Date().toISOString();
    this.#db.prepare("UPDATE organization_jobs SET status='interrupted', updated_at=?, run_token=run_token+1 WHERE status IN ('running','pausing','canceling')").run(now);
    this.#db.prepare("UPDATE organization_items SET status='queued', started_at=NULL WHERE status='running'").run();
  }

  close(): void { this.#db.close(); }

  #touchItemJob(itemId: string, now: string): void {
    this.#db.prepare("UPDATE organization_jobs SET updated_at=? WHERE id=(SELECT job_id FROM organization_items WHERE id=?)").run(now, itemId);
  }

  #projectJob(row: JobRow): OrganizationJob {
    const latest = this.#db.prepare("SELECT session_id,native_turn_id,operation,completed_at FROM organization_items WHERE job_id=? AND status='success' ORDER BY completed_at DESC, rowid DESC LIMIT 1").get(row.id) as { session_id: string; native_turn_id: string | null; operation: OrganizationOperation; completed_at: string | null } | undefined;
    return {
      id: row.id, workspaceId: row.workspace_id, mode: row.mode, sessionId: row.session_id ?? undefined,
      status: row.status, createdAt: row.created_at, startedAt: row.started_at ?? undefined, updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined, requestedBy: row.requested_by, runToken: row.run_token, error: row.error ?? undefined,
      planningMs: row.planning_ms, snapshotPreparationMs: row.snapshot_preparation_ms,
      counts: this.#counts(row),
      lastCommitted: latest ? { sessionId: latest.session_id, nativeTurnId: latest.native_turn_id ?? undefined, operation: latest.operation, completedAt: latest.completed_at ?? undefined } : undefined,
    };
  }

  #counts(job: JobRow): OrganizationCounts {
    const rows = this.#db.prepare("SELECT operation,status,COUNT(*) count FROM organization_items WHERE job_id=? GROUP BY operation,status").all(job.id) as unknown as { operation: OrganizationOperation; status: OrganizationItemStatus; count: number }[];
    const empty = (): { planned: number; completed: number; generated: number; reused: number; failed: number } => ({ planned: 0, completed: 0, generated: 0, reused: 0, failed: 0 });
    const byOperation = { trace: empty(), title: empty(), parent: empty() };
    byOperation.trace.reused = job.reused_trace; byOperation.title.reused = job.reused_title; byOperation.parent.reused = job.reused_parent;
    const totals = { planned: 0, queued: 0, running: 0, generated: 0, reused: job.reused_trace + job.reused_title + job.reused_parent, failed: 0, canceled: 0, stale: 0 };
    for (const row of rows) {
      const op = byOperation[row.operation]; op.planned += row.count; totals.planned += row.count;
      if (["success", "reused"].includes(row.status)) op.completed += row.count;
      if (row.status === "success") { op.generated += row.count; totals.generated += row.count; }
      if (row.status === "reused") { op.reused += row.count; totals.reused += row.count; }
      if (row.status === "failed") { op.failed += row.count; totals.failed += row.count; }
      if (row.status === "queued") totals.queued += row.count;
      if (row.status === "running") totals.running += row.count;
      if (row.status === "canceled") totals.canceled += row.count;
      if (row.status === "stale") totals.stale += row.count;
    }
    return { ...totals, byOperation };
  }

  #ensureReuseColumns(): void {
    const columns = new Set((this.#db.prepare("PRAGMA table_info(organization_jobs)").all() as unknown as { name: string }[]).map((column) => column.name));
    for (const name of ["reused_trace", "reused_title", "reused_parent"]) if (!columns.has(name)) this.#db.exec(`ALTER TABLE organization_jobs ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
  }

  #ensureMetricColumns(): void {
    const jobColumns = new Set((this.#db.prepare("PRAGMA table_info(organization_jobs)").all() as unknown as { name: string }[]).map((column) => column.name));
    for (const [name, type] of [["planning_ms", "REAL"], ["snapshot_preparation_ms", "REAL"]] as const) if (!jobColumns.has(name)) this.#db.exec(`ALTER TABLE organization_jobs ADD COLUMN ${name} ${type} NOT NULL DEFAULT 0`);
    const itemColumns = new Set((this.#db.prepare("PRAGMA table_info(organization_items)").all() as unknown as { name: string }[]).map((column) => column.name));
    for (const [name, type] of [["queue_ms", "REAL"], ["input_chars", "INTEGER"], ["model_ms", "REAL"], ["validation_ms", "REAL"], ["commit_ms", "REAL"], ["retry_count", "INTEGER"]] as const) if (!itemColumns.has(name)) this.#db.exec(`ALTER TABLE organization_items ADD COLUMN ${name} ${type} NOT NULL DEFAULT 0`);
  }
}

interface JobRow { id: string; workspace_id: string; mode: OrganizationMode; session_id: string | null; status: OrganizationJobStatus; created_at: string; started_at: string | null; updated_at: string; completed_at: string | null; requested_by: string; run_token: number; error: string | null; reused_trace: number; reused_title: number; reused_parent: number; planning_ms: number; snapshot_preparation_ms: number }
interface ItemRow { id: string; job_id: string; workspace_id: string; session_id: string; native_turn_id: string | null; entity_type: "turn" | "session"; operation: OrganizationOperation; source_fingerprint: string; strategy_version: string; status: OrganizationItemStatus; attempts: number; error_code: OrganizationItem["errorCode"] | null; error: string | null; started_at: string | null; completed_at: string | null; queue_ms: number; input_chars: number; model_ms: number; validation_ms: number; commit_ms: number; retry_count: number }
function projectItem(row: ItemRow): OrganizationItem { return { id: row.id, jobId: row.job_id, workspaceId: row.workspace_id, sessionId: row.session_id, nativeTurnId: row.native_turn_id ?? undefined, entityType: row.entity_type, operation: row.operation, sourceFingerprint: row.source_fingerprint, strategyVersion: row.strategy_version, status: row.status, attempts: row.attempts, errorCode: row.error_code ?? undefined, error: row.error ?? undefined, startedAt: row.started_at ?? undefined, completedAt: row.completed_at ?? undefined, metrics: { queueMs: row.queue_ms, inputChars: row.input_chars, modelMs: row.model_ms, validationMs: row.validation_ms, commitMs: row.commit_ms, retryCount: row.retry_count } }; }
