import { randomUUID } from "node:crypto";
import type { Session, Turn } from "../../core/src/index.ts";
import { OrganizationRepository } from "./repository.ts";
import type { OrganizationErrorCode, OrganizationFreshness, OrganizationItem, OrganizationJob, OrganizationRequest, ProgressiveOrganizationPort, WorkspaceOrganizationBaseSnapshot } from "./types.ts";

export class ProgressiveOrganizationService {
  readonly #repository: OrganizationRepository;
  readonly #port: ProgressiveOrganizationPort;
  readonly #controllers = new Map<string, AbortController>();
  readonly #running = new Set<string>();
  readonly #tasks = new Map<string, Promise<void>>();
  readonly #snapshots = new Map<string, WorkspaceOrganizationBaseSnapshot>();
  readonly #now: () => Date;

  constructor(options: { repository: OrganizationRepository; port: ProgressiveOrganizationPort; now?: () => Date }) {
    this.#repository = options.repository;
    this.#port = options.port;
    this.#now = options.now ?? (() => new Date());
  }

  async start(request: OrganizationRequest): Promise<OrganizationJob> {
    const active = this.#repository.active(request.workspaceId);
    if (active) return active;
    const snapshotStarted = performance.now();
    const snapshot = await this.#prepareSnapshot(request.workspaceId);
    const snapshotPreparationMs = performance.now() - snapshotStarted;
    const planningStarted = performance.now();
    const plan = await this.#plan(request, snapshot);
    const job = this.#repository.createJob(randomUUID(), request, plan.items, this.#stamp(), plan.reused, { planningMs: performance.now() - planningStarted, snapshotPreparationMs });
    this.#snapshots.set(job.id, snapshot);
    this.#schedule(job.id);
    return this.#repository.getJob(job.id)!;
  }

  get(jobId: string): OrganizationJob | undefined { return this.#repository.getJob(jobId); }
  latest(workspaceId: string): OrganizationJob | undefined { return this.#repository.latest(workspaceId); }
  items(jobId: string): readonly OrganizationItem[] { return this.#repository.listItems(jobId); }

  pause(jobId: string): OrganizationJob {
    const job = this.#require(jobId);
    if (job.status === "running" || job.status === "queued") return this.#repository.updateJob(jobId, "pausing", this.#stamp());
    return job;
  }

  cancel(jobId: string): OrganizationJob {
    const job = this.#require(jobId);
    if (["completed", "completed_with_failures", "canceled", "failed"].includes(job.status)) return job;
    const updated = this.#repository.updateJob(jobId, "canceling", this.#stamp(), { incrementToken: true });
    this.#controllers.get(jobId)?.abort();
    if (!this.#running.has(jobId)) this.#finishCanceled(jobId);
    return updated;
  }

  resume(jobId: string): OrganizationJob {
    const job = this.#require(jobId);
    if (!["paused", "interrupted"].includes(job.status)) return job;
    const updated = this.#repository.updateJob(jobId, "queued", this.#stamp(), { incrementToken: true });
    this.#schedule(jobId);
    return updated;
  }

  retryFailed(jobId: string): OrganizationJob {
    const job = this.#require(jobId);
    if (!["completed_with_failures", "failed", "paused", "interrupted", "canceled"].includes(job.status)) return job;
    this.#repository.resetRetryable(jobId, this.#stamp());
    this.#schedule(jobId);
    return this.#repository.getJob(jobId)!;
  }

  async shutdown(): Promise<void> {
    for (const controller of this.#controllers.values()) controller.abort();
    this.#repository.interruptActiveJobs();
    await Promise.allSettled(this.#tasks.values());
    this.#snapshots.clear();
  }

  #schedule(jobId: string): void {
    if (this.#running.has(jobId)) return;
    this.#running.add(jobId);
    const task = new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => this.#run(jobId)).finally(() => { this.#running.delete(jobId); this.#tasks.delete(jobId); });
    this.#tasks.set(jobId, task);
  }

  async #run(jobId: string): Promise<void> {
    const controller = new AbortController();
    this.#controllers.set(jobId, controller);
    try {
      let job = this.#require(jobId);
      if (job.status === "canceling") { this.#finishCanceled(jobId); return; }
      if (job.status === "pausing") { this.#repository.updateJob(jobId, "paused", this.#stamp()); return; }
      if (job.status !== "queued") return;
      if (!this.#snapshots.has(jobId)) {
        const started = performance.now();
        this.#snapshots.set(jobId, await this.#prepareSnapshot(job.workspaceId));
        this.#repository.addSnapshotPreparation(jobId, performance.now() - started);
      }
      job = this.#repository.updateJob(jobId, "running", this.#stamp());
      const token = job.runToken;
      const snapshot = this.#snapshots.get(jobId)!;
      for (;;) {
        job = this.#require(jobId);
        if (job.status === "interrupted") return;
        if (job.runToken !== token || job.status === "canceling") return this.#finishCanceled(jobId);
        if (job.status === "pausing") { this.#repository.updateJob(jobId, "paused", this.#stamp()); return; }
        const item = this.#repository.nextQueued(jobId);
        if (!item) break;
        await this.#execute(item, token, controller.signal, snapshot);
      }
      const counts = this.#require(jobId).counts;
      this.#repository.updateJob(jobId, counts.failed || counts.stale ? "completed_with_failures" : "completed", this.#stamp());
    } catch (error) {
      const job = this.#require(jobId);
      if (job.status === "interrupted") return;
      if (job.status === "canceling") this.#finishCanceled(jobId);
      else if (controller.signal.aborted) this.#repository.updateJob(jobId, "interrupted", this.#stamp());
      else this.#repository.updateJob(jobId, "failed", this.#stamp(), { error: message(error) });
    } finally {
      this.#controllers.delete(jobId);
      const status = this.#repository.getJob(jobId)?.status;
      if (status && ["completed", "completed_with_failures", "canceled", "failed"].includes(status)) this.#snapshots.delete(jobId);
    }
  }

  async #execute(item: OrganizationItem, token: number, signal: AbortSignal, snapshot: WorkspaceOrganizationBaseSnapshot): Promise<void> {
    const now = this.#stamp();
    const queuedAt = Date.parse(this.#require(item.jobId).createdAt);
    this.#repository.addItemMetrics(item.id, { queueMs: Math.max(0, Date.parse(now) - queuedAt) });
    this.#repository.updateItem(item.id, "running", now, { incrementAttempts: true });
    try {
      const before = await this.#inspect(item, snapshot);
      if (before.freshness === "current") {
        this.#repository.updateItem(item.id, "reused", this.#stamp(), { sourceFingerprint: before.sourceFingerprint, strategyVersion: before.strategyVersion });
        return;
      }
      const mayCommit = () => {
        const current = this.#repository.getJob(item.jobId);
        return Boolean(current && current.runToken === token && !["canceling", "canceled", "interrupted"].includes(current.status));
      };
      await this.#generate(item, {
        signal,
        expectedFingerprint: before.sourceFingerprint,
        mayCommit,
        recordMetrics: (metrics) => this.#repository.addItemMetrics(item.id, metrics),
        snapshot,
      });
      if (!mayCommit()) {
        this.#repository.updateItem(item.id, "canceled", this.#stamp(), { errorCode: "canceled", error: "Result discarded after cancellation." });
        return;
      }
      const after = await this.#inspect(item);
      if (after.sourceFingerprint !== before.sourceFingerprint || after.freshness !== "current") {
        this.#repository.updateItem(item.id, "stale", this.#stamp(), { errorCode: "source_changed", error: "Source changed while this item was generated.", sourceFingerprint: after.sourceFingerprint, strategyVersion: after.strategyVersion });
        return;
      }
      this.#repository.updateItem(item.id, "success", this.#stamp(), { sourceFingerprint: after.sourceFingerprint, strategyVersion: after.strategyVersion });
      this.#port.onCommitted?.({ ...item, status: "success", attempts: item.attempts + 1, sourceFingerprint: after.sourceFingerprint, strategyVersion: after.strategyVersion, completedAt: this.#stamp() });
    } catch (error) {
      const job = this.#repository.getJob(item.jobId);
      if (job?.status === "interrupted") {
        this.#repository.updateItem(item.id, "queued", this.#stamp());
        return;
      }
      const canceled = signal.aborted || !job || job.status === "canceling";
      this.#repository.updateItem(item.id, canceled ? "canceled" : "failed", this.#stamp(), { errorCode: canceled ? "canceled" : classify(error), error: message(error) });
    }
  }

  async #plan(request: OrganizationRequest, snapshot: WorkspaceOrganizationBaseSnapshot): Promise<{ items: Omit<OrganizationItem, "jobId" | "status" | "attempts" | "metrics">[]; reused: Record<"trace" | "title" | "parent", number> }> {
    const sessions = snapshot.sessions
      .filter((session) => !session.excludedFromMainWorkspaceForest && (!request.sessionId || session.providerSessionId === request.sessionId))
      .sort(priority(request));
    const items: Omit<OrganizationItem, "jobId" | "status" | "attempts" | "metrics">[] = [];
    const reused = { trace: 0, title: 0, parent: 0 };
    const traceSessions = new Set<string>();
    if (request.mode === "full") {
      for (const session of sessions) {
        for (const turn of (snapshot.turnsBySession.get(session.providerSessionId) ?? []).slice().sort((a, b) => a.displayOrdinal - b.displayOrdinal)) {
          const state = await this.#port.inspectTrace(turn);
          if (needsWork(state, request.staleOnly)) {
            items.push(planned(request.workspaceId, session, turn, "trace", state));
            traceSessions.add(session.providerSessionId);
          } else if (state.freshness === "current") reused.trace += 1;
        }
      }
    }
    const titleSessions = new Set<string>();
    for (const session of sessions) {
      const state = await this.#port.inspectTitle(session, snapshot);
      if (needsWork(state, request.staleOnly) || traceSessions.has(session.providerSessionId)) {
        items.push(planned(request.workspaceId, session, undefined, "title", state));
        titleSessions.add(session.providerSessionId);
      } else if (state.freshness === "current") reused.title += 1;
    }
    for (const session of sessions) {
      const state = await this.#port.inspectParent(session, snapshot);
      // Parent inputs include ranked Workspace candidates, so any planned title can invalidate a current relation.
      if (needsWork(state, request.staleOnly) || titleSessions.size > 0) items.push(planned(request.workspaceId, session, undefined, "parent", state));
      else if (state.freshness === "current") reused.parent += 1;
    }
    return { items, reused };
  }

  async #inspect(item: OrganizationItem, snapshot?: WorkspaceOrganizationBaseSnapshot): Promise<OrganizationFreshness> {
    const sessions = snapshot?.sessions ?? await this.#port.listSessions(item.workspaceId);
    const session = sessions.find((value) => value.providerSessionId === item.sessionId);
    if (!session) throw new Error("Organization Session is no longer available.");
    if (item.operation === "title") return this.#port.inspectTitle(session, snapshot);
    if (item.operation === "parent") return this.#port.inspectParent(session, snapshot);
    const turns = snapshot?.turnsBySession.get(item.sessionId) ?? await this.#port.listTurns(item.sessionId);
    const turn = turns.find((value) => value.nativeTurnId === item.nativeTurnId);
    if (!turn) throw new Error("Organization Turn is no longer available.");
    return this.#port.inspectTrace(turn);
  }

  async #generate(item: OrganizationItem, context: Parameters<ProgressiveOrganizationPort["generateTitle"]>[1]): Promise<void> {
    const session = context.snapshot.sessions.find((value) => value.providerSessionId === item.sessionId);
    if (!session) throw new Error("Organization Session is no longer available.");
    if (item.operation === "title") return this.#port.generateTitle(session, context);
    if (item.operation === "parent") return this.#port.generateParent(session, context);
    const turn = context.snapshot.turnsBySession.get(item.sessionId)?.find((value) => value.nativeTurnId === item.nativeTurnId);
    if (!turn) throw new Error("Organization Turn is no longer available.");
    return this.#port.generateTrace(turn, context);
  }

  #finishCanceled(jobId: string): void {
    this.#repository.cancelPending(jobId, this.#stamp());
    this.#repository.updateJob(jobId, "canceled", this.#stamp());
  }

  async #prepareSnapshot(workspaceId: string): Promise<WorkspaceOrganizationBaseSnapshot> {
    const sessions = (await this.#port.listSessions(workspaceId)).filter((session) => !session.excludedFromMainWorkspaceForest);
    const [turnEntries, lineageEntries] = await Promise.all([
      Promise.all(sessions.map(async (session) => [session.providerSessionId, await this.#port.listTurns(session.providerSessionId)] as const)),
      Promise.all(sessions.map(async (session) => [session.providerSessionId, await this.#port.getNativeLineage?.(session.providerSessionId) ?? null] as const)),
    ]);
    return { workspaceId, sessions, turnsBySession: new Map(turnEntries), nativeLineageBySession: new Map(lineageEntries) };
  }

  #require(jobId: string): OrganizationJob {
    const job = this.#repository.getJob(jobId);
    if (!job) throw new Error("Organization job was not found.");
    return job;
  }

  #stamp(): string { return this.#now().toISOString(); }
}

function planned(workspaceId: string, session: Session, turn: Turn | undefined, operation: "trace" | "title" | "parent", state: OrganizationFreshness): Omit<OrganizationItem, "jobId" | "status" | "attempts" | "metrics"> {
  return { id: randomUUID(), workspaceId, sessionId: session.providerSessionId, nativeTurnId: turn?.nativeTurnId, entityType: turn ? "turn" : "session", operation, sourceFingerprint: state.sourceFingerprint, strategyVersion: state.strategyVersion };
}

function needsWork(state: OrganizationFreshness, staleOnly?: boolean): boolean { return staleOnly ? state.freshness === "stale" : state.freshness !== "current"; }
function priority(request: OrganizationRequest): (a: Session, b: Session) => number {
  const expanded = new Set(request.expandedSessionIds ?? []);
  const rank = (value: Session) => value.providerSessionId === request.selectedSessionId ? 0 : expanded.has(value.providerSessionId) ? 1 : 2;
  return (a, b) => rank(a) - rank(b) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.providerSessionId.localeCompare(b.providerSessionId);
}
function message(error: unknown): string { return error instanceof Error ? error.message : "Unknown organization error"; }
function classify(error: unknown): OrganizationErrorCode {
  const value = message(error).toLowerCase();
  if (value.includes("unavailable") || value.includes("not installed")) return "model_unavailable";
  if (value.includes("timeout") || value.includes("timed out")) return "model_timeout";
  if (value.includes("validation") || value.includes("cycle")) return "semantic_validation";
  if (value.includes("json") || value.includes("invalid")) return "generation_invalid";
  return "unknown";
}
