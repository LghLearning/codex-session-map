import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Session, Turn } from "../../core/src/index.ts";
import { OrganizationRepository, ProgressiveOrganizationService, type OrganizationExecutionContext, type OrganizationFreshness, type ProgressiveOrganizationPort } from "../src/index.ts";

test("Quick plans stale/missing titles and parents without generating traces", async () => {
  const fixture = new FixturePort();
  fixture.title.set("b", "current"); fixture.parent.set("b", "current");
  const { service, repository } = setup(fixture);
  const started = await service.start({ workspaceId: "workspace", mode: "quick" });
  const finished = await waitFor(service, started.id, "completed");
  assert.equal(fixture.calls.some((value) => value.startsWith("trace:")), false);
  assert.deepEqual(fixture.calls, ["title:a", "parent:a"]);
  assert.equal(finished.counts.generated, 2);
  assert.equal(finished.counts.reused, 2);
  const second = await service.start({ workspaceId: "workspace", mode: "quick" });
  const current = await waitFor(service, second.id, "completed");
  assert.equal(current.counts.planned, 0);
  assert.equal(current.counts.reused, 4);
  repository.close();
});

test("Full runs missing traces before dependent title and parent with concurrency one", async () => {
  const fixture = new FixturePort();
  const { service, repository } = setup(fixture);
  const started = await service.start({ workspaceId: "workspace", mode: "full", selectedSessionId: "b" });
  await waitFor(service, started.id, "completed");
  assert.equal(fixture.maxConcurrent, 1);
  assert.deepEqual(fixture.calls.slice(0, 4), ["trace:b/turn-b", "trace:a/turn-a", "title:b", "title:a"]);
  assert.deepEqual(fixture.calls.slice(-2), ["parent:b", "parent:a"]);
  repository.close();
});

test("runtime metrics persist planning and per-operation timing without changing execution", async () => {
  const fixture = new FixturePort();
  fixture.title.set("b", "current"); fixture.parent.set("b", "current");
  const { service, repository } = setup(fixture);
  const started = await service.start({ workspaceId: "workspace", mode: "quick" });
  const finished = await waitFor(service, started.id, "completed");
  assert.ok(finished.planningMs >= 0);
  assert.equal(finished.snapshotPreparationMs, 0);
  const generated = service.items(started.id).filter((item) => item.status === "success");
  assert.equal(generated.length, 2);
  for (const item of generated) {
    assert.equal(item.metrics.inputChars, 120);
    assert.equal(item.metrics.modelMs, 7);
    assert.equal(item.metrics.validationMs, 2);
    assert.equal(item.metrics.commitMs, 1);
    assert.equal(item.metrics.retryCount, 1);
    assert.ok(item.metrics.queueMs >= 0);
  }
  repository.close();
});

test("one failed item does not stop later items and retry executes only failed work", async () => {
  const fixture = new FixturePort(); fixture.failOnce.add("title:a");
  const { service, repository } = setup(fixture);
  const started = await service.start({ workspaceId: "workspace", mode: "quick" });
  const failed = await waitFor(service, started.id, "completed_with_failures");
  assert.equal(failed.counts.failed, 1);
  assert.ok(fixture.calls.includes("parent:b"));
  const before = fixture.calls.length;
  service.retryFailed(started.id);
  const completed = await waitFor(service, started.id, "completed");
  assert.equal(completed.counts.failed, 0);
  assert.deepEqual(fixture.calls.slice(before), ["title:a"]);
  repository.close();
});

test("Pause waits for the current item, resume keeps successes, and Cancel discards a late result", async () => {
  const fixture = new FixturePort(); fixture.gate = deferred<void>();
  const { service, repository } = setup(fixture);
  const started = await service.start({ workspaceId: "workspace", mode: "quick" });
  await waitUntil(() => service.get(started.id)?.counts.running === 1);
  service.pause(started.id); fixture.gate.resolve();
  const paused = await waitFor(service, started.id, "paused");
  assert.equal(paused.counts.generated, 1);
  const completedKey = fixture.calls[0]!;
  const successfulCalls = fixture.calls.length;
  service.resume(started.id); await waitFor(service, started.id, "completed");
  assert.equal(fixture.calls.slice(successfulCalls).includes(completedKey), false);

  fixture.reset(); fixture.gate = deferred<void>();
  const second = await service.start({ workspaceId: "other", mode: "quick" });
  await waitUntil(() => service.get(second.id)?.counts.running === 1);
  service.cancel(second.id); fixture.gate.resolve();
  const canceled = await waitFor(service, second.id, "canceled");
  assert.equal(canceled.counts.generated, 0);
  repository.close();
});

test("reopening persistent storage marks active work interrupted without restarting it", () => {
  const directory = mkdtempSync(join(tmpdir(), "organization-restart-")); const path = join(directory, "jobs.sqlite");
  try {
    const first = new OrganizationRepository(path);
    const job = first.createJob("job", { workspaceId: "workspace", mode: "quick" }, [{ id: "item", workspaceId: "workspace", sessionId: "a", entityType: "session", operation: "title", sourceFingerprint: "a", strategyVersion: "v1" }], new Date().toISOString());
    first.updateJob(job.id, "running", new Date().toISOString()); first.updateItem("item", "running", new Date().toISOString()); first.close();
    const reopened = new OrganizationRepository(path);
    assert.equal(reopened.getJob(job.id)?.status, "interrupted");
    assert.equal(reopened.listItems(job.id)[0]?.status, "queued");
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("shutdown keeps an in-flight item resumable and never converts interrupted to canceled", async () => {
  const fixture = new FixturePort(); fixture.gate = deferred<void>();
  const { service, repository } = setup(fixture);
  const started = await service.start({ workspaceId: "workspace", mode: "quick" });
  await waitUntil(() => service.get(started.id)?.counts.running === 1);
  const stopping = service.shutdown(); fixture.gate.resolve(); await stopping;
  assert.equal(service.get(started.id)?.status, "interrupted");
  assert.equal(service.items(started.id).filter((item) => item.status === "queued").length > 0, true);
  repository.close();
});

test("a source change during generation marks the item stale instead of current success", async () => {
  const fixture = new FixturePort(); fixture.changeSourceOn.add("title:b");
  fixture.title.set("a", "current"); fixture.parent.set("a", "current"); fixture.parent.set("b", "current");
  const { service, repository } = setup(fixture);
  const started = await service.start({ workspaceId: "workspace", mode: "quick" });
  const finished = await waitFor(service, started.id, "completed_with_failures");
  assert.equal(finished.counts.stale, 1);
  assert.equal(finished.counts.generated, 0);
  repository.close();
});

class FixturePort implements ProgressiveOrganizationPort {
  readonly sessions = [session("a"), session("b")];
  readonly turns = new Map(this.sessions.map((value) => [value.providerSessionId, [turn(value.providerSessionId)]]));
  readonly trace = new Map<string, OrganizationFreshness["freshness"]>();
  readonly title = new Map<string, OrganizationFreshness["freshness"]>();
  readonly parent = new Map<string, OrganizationFreshness["freshness"]>();
  readonly failOnce = new Set<string>(); readonly calls: string[] = [];
  readonly changeSourceOn = new Set<string>(); readonly fingerprints = new Map<string, string>();
  concurrent = 0; maxConcurrent = 0; gate?: ReturnType<typeof deferred<void>>;
  async listSessions() { return this.sessions; }
  async listTurns(sessionId: string) { return this.turns.get(sessionId) ?? []; }
  async inspectTrace(value: Turn) { const key = `trace:${value.sessionId}/${value.nativeTurnId}`; return state(this.trace.get(`${value.sessionId}/${value.nativeTurnId}`), this.fingerprints.get(key)); }
  async inspectTitle(value: Session) { const key = `title:${value.providerSessionId}`; return state(this.title.get(value.providerSessionId), this.fingerprints.get(key)); }
  async inspectParent(value: Session) { const key = `parent:${value.providerSessionId}`; return state(this.parent.get(value.providerSessionId), this.fingerprints.get(key)); }
  async generateTrace(value: Turn, context: OrganizationExecutionContext) { await this.generate(`trace:${value.sessionId}/${value.nativeTurnId}`, context, () => this.trace.set(`${value.sessionId}/${value.nativeTurnId}`, "current")); }
  async generateTitle(value: Session, context: OrganizationExecutionContext) { await this.generate(`title:${value.providerSessionId}`, context, () => this.title.set(value.providerSessionId, "current")); }
  async generateParent(value: Session, context: OrganizationExecutionContext) { await this.generate(`parent:${value.providerSessionId}`, context, () => this.parent.set(value.providerSessionId, "current")); }
  reset() { this.title.clear(); this.parent.clear(); this.trace.clear(); this.calls.length = 0; }
  async generate(key: string, context: OrganizationExecutionContext, commit: () => void) {
    this.calls.push(key); this.concurrent += 1; this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      context.recordMetrics({ inputChars: 120, modelMs: 7, validationMs: 2, commitMs: 1, retryCount: 1 });
      if (this.failOnce.delete(key)) throw new Error("model unavailable");
      if (this.gate) { const gate = this.gate; await gate.promise; if (this.gate === gate) this.gate = undefined; }
      if (this.changeSourceOn.delete(key)) this.fingerprints.set(key, "changed-fingerprint");
      if (context.mayCommit() && !context.signal.aborted) commit();
    } finally { this.concurrent -= 1; }
  }
}

function setup(port: FixturePort) { const repository = new OrganizationRepository(); return { repository, service: new ProgressiveOrganizationService({ repository, port }) }; }
function state(freshness: OrganizationFreshness["freshness"] = "missing", sourceFingerprint = "source-fingerprint"): OrganizationFreshness { return { freshness, sourceFingerprint, strategyVersion: "v1" }; }
function session(id: string): Session { return { providerId: "fixture", providerSessionId: id, workspaceScopeId: id === "a" || id === "b" ? "workspace" : "other", title: id, updatedAt: id === "b" ? "2026-01-02" : "2026-01-01", archiveStatus: "active", sourceKind: "interactive", excludedFromMainWorkspaceForest: false, nativeLineageAvailability: "none", health: { state: "complete", issues: [] }, provenance: [{ providerId: "fixture", tier: "primary", completeness: "complete" }] }; }
function turn(sessionId: string): Turn { return { providerId: "fixture", sessionId, nativeTurnId: `turn-${sessionId}`, displayOrdinal: 1, initiatorKind: "user", status: "completed", input: { text: "input", format: "plain" }, tools: [], provenance: [] }; }
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function waitUntil(predicate: () => boolean, timeout = 2_000) { const started = Date.now(); while (!predicate()) { if (Date.now() - started > timeout) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); } }
async function waitFor(service: ProgressiveOrganizationService, jobId: string, status: string) { await waitUntil(() => service.get(jobId)?.status === status); return service.get(jobId)!; }
