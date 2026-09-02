import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Turn } from "../../core/src/index.ts";
import {
  normalizeTraceText,
  buildSemanticTraceRequest,
  PromptTurnSemanticTraceGenerator,
  semanticInputFingerprint,
  SessionSemanticTraceIndexer,
  SqliteSemanticTraceStore,
  TurnSemanticTraceService,
  type TurnSemanticTraceGenerator,
} from "../src/index.ts";

test("semantic fingerprints ignore display/provenance changes but detect public content changes", () => {
  const base = fixtureTurn();
  const sourceChanged = {
    ...base,
    displayOrdinal: 99,
    provenance: [{ providerId: "fixture", tier: "reconciliation" as const, completeness: "partial" as const }],
  };
  assert.equal(semanticInputFingerprint(sourceChanged), semanticInputFingerprint(base));
  assert.notEqual(semanticInputFingerprint({ ...base, assistantFinal: "A changed public outcome." }), semanticInputFingerprint(base));
});

test("trace service is idempotent and invalidates on input or generator version change", async () => {
  const store = new SqliteSemanticTraceStore();
  const firstGenerator = generator("trace-v1", "1", "Summarized the fixture Turn.");
  const service = new TurnSemanticTraceService({ store, generator: firstGenerator, now: () => new Date("2026-08-31T00:00:00.000Z") });
  const turn = fixtureTurn();
  const first = await service.ensure(turn);
  const second = await service.ensure(turn);
  assert.deepEqual(second, first);
  assert.equal(firstGenerator.calls, 1);
  assert.equal((await service.regenerate(turn)).text, "Summarized the fixture Turn.");
  assert.equal(firstGenerator.calls, 2);
  assert.equal((await service.inspect(turn)).freshness, "current");
  assert.equal((await service.inspect({ ...turn, input: { ...turn.input, text: "Changed input" } })).freshness, "stale");

  const upgradedGenerator = generator("trace-v1", "2", "Regenerated after a generator upgrade.");
  const upgraded = new TurnSemanticTraceService({ store, generator: upgradedGenerator, now: () => new Date("2026-09-01T00:00:00.000Z") });
  assert.equal((await upgraded.inspect(turn)).freshness, "stale");
  assert.equal((await upgraded.ensure(turn)).generator.version, "2");
  assert.equal(upgradedGenerator.calls, 1);
  await store.close();
});

test("concurrent indexing coalesces generation and a failure preserves the prior trace", async () => {
  const store = new SqliteSemanticTraceStore();
  const turn = fixtureTurn();
  const stable = generator("stable", "1", "A stable generated trace.");
  const service = new TurnSemanticTraceService({ store, generator: stable });
  const [left, right] = await Promise.all([service.ensure(turn), service.ensure(turn)]);
  assert.deepEqual(left, right);
  assert.equal(stable.calls, 1);

  const failing: TurnSemanticTraceGenerator = {
    identity: { id: "stable", version: "2" },
    async generate() { throw new Error("fixture generator unavailable"); },
  };
  const upgraded = new TurnSemanticTraceService({ store, generator: failing });
  await assert.rejects(() => upgraded.ensure(turn), /generator unavailable/);
  assert.equal((await store.get(turn))?.text, "A stable generated trace.");
  await store.close();
});

test("SQLite store preserves authoritative feedback across AI regeneration and reopen", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-semantic-store-"));
  const path = join(root, "semantic.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  const turn = fixtureTurn();
  const firstStore = new SqliteSemanticTraceStore(path);
  const service = new TurnSemanticTraceService({
    store: firstStore,
    generator: generator("fixture-generator", "1", "  One\nline   semantic trace. "),
    now: () => new Date("2026-08-31T00:00:00.000Z"),
  });
  const original = await service.ensure(turn);
  await firstStore.putUserFeedback({
    providerId: turn.providerId,
    sessionId: turn.sessionId,
    nativeTurnId: turn.nativeTurnId,
    verdict: "edited",
    aiOriginalText: original.text,
    editedText: "用户修正后的语义轨迹。",
    sourceFingerprint: original.inputFingerprint,
    reviewedAt: "2026-08-31T01:00:00.000Z",
  });
  const regenerated = new TurnSemanticTraceService({
    store: firstStore,
    generator: generator("fixture-generator", "2", "A regenerated AI trace."),
  });
  await regenerated.ensure(turn);
  await firstStore.close();

  const reopened = new SqliteSemanticTraceStore(path);
  const traces = await reopened.listSession(turn.providerId, turn.sessionId);
  assert.equal(reopened.schemaVersion, 4);
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.text, "A regenerated AI trace.");
  assert.deepEqual(await reopened.getUserFeedback(turn), {
    providerId: turn.providerId,
    sessionId: turn.sessionId,
    nativeTurnId: turn.nativeTurnId,
    verdict: "edited",
    aiOriginalText: "One line semantic trace.",
    editedText: "用户修正后的语义轨迹。",
    sourceFingerprint: original.inputFingerprint,
    reviewedAt: "2026-08-31T01:00:00.000Z",
  });
  assert.equal(Object.keys(traces[0] ?? {}).some((key) => /parent|title|override|lock/i.test(key)), false);
  await reopened.close();
});

test("SQLite store upgrades a version-1 trace cache through the Semantic Parent schema without losing traces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-semantic-store-v1-"));
  const path = join(root, "semantic.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE turn_semantic_traces (
      provider_id TEXT NOT NULL, session_id TEXT NOT NULL, native_turn_id TEXT NOT NULL,
      trace_text TEXT NOT NULL, input_fingerprint TEXT NOT NULL, generator_id TEXT NOT NULL,
      generator_version TEXT NOT NULL, generator_model TEXT, generated_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, session_id, native_turn_id)
    );
    INSERT INTO turn_semantic_traces VALUES (
      'fixture-provider', 'session-1', 'turn-native-1', '旧版缓存轨迹。', 'legacy-fingerprint',
      'legacy-generator', '1', 'fixture-model', '2026-08-30T00:00:00.000Z'
    );
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const upgraded = new SqliteSemanticTraceStore(path);
  assert.equal(upgraded.schemaVersion, 4);
  assert.equal((await upgraded.get(fixtureTurn()))?.text, "旧版缓存轨迹。");
  assert.equal(await upgraded.getUserFeedback(fixtureTurn()), undefined);
  assert.equal(await upgraded.getSessionTitle(fixtureTurn().providerId, fixtureTurn().sessionId), undefined);
  await upgraded.putUserFeedback({
    ...fixtureTurn(),
    verdict: "accepted",
    aiOriginalText: "旧版缓存轨迹。",
    sourceFingerprint: "legacy-fingerprint",
    reviewedAt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal((await upgraded.getUserFeedback(fixtureTurn()))?.verdict, "accepted");
  await upgraded.close();
});

test("trace validation rejects empty and unbounded model output", () => {
  assert.throws(() => normalizeTraceText(" \n "), /must not be empty/);
  assert.throws(() => normalizeTraceText("x".repeat(241)), /240/);
});

test("session indexer consumes every provider page and reuses current traces", async () => {
  const store = new SqliteSemanticTraceStore();
  const traceGenerator = generator("batch", "1", "Indexed a provider-neutral Turn.");
  const service = new TurnSemanticTraceService({ store, generator: traceGenerator });
  const turns = [fixtureTurn(), { ...fixtureTurn(), nativeTurnId: "turn-native-2", displayOrdinal: 2 }];
  const provider = {
    async listTurns(_sessionId: string, cursor?: string) {
      return cursor ? { data: [turns[1]!] } : { data: [turns[0]!], nextCursor: "page-2" };
    },
  };
  const indexer = new SessionSemanticTraceIndexer({ provider, service });
  assert.deepEqual(await indexer.indexSession("session-1"), {
    sessionId: "session-1",
    traces: await Promise.all(turns.map((turn) => service.ensure(turn))),
    generated: 2,
    reused: 0,
  });
  const second = await indexer.indexSession("session-1");
  assert.equal(second.generated, 0);
  assert.equal(second.reused, 2);
  assert.equal(traceGenerator.calls, 2);
  await store.close();
});

test("prompt generator exposes only public provider-neutral Turn content", async () => {
  const requests: unknown[] = [];
  const traceGenerator = new PromptTurnSemanticTraceGenerator({
    client: {
      model: "fixture-model",
      async complete(request) { requests.push(request); return "Inspected the adapter and confirmed read-only behavior."; },
    },
    promptVersion: "fixture-v1",
  });
  const generated = await traceGenerator.generate(fixtureTurn());
  const request = buildSemanticTraceRequest(fixtureTurn());
  assert.equal(generated.text, "Inspected the adapter and confirmed read-only behavior.");
  assert.equal(traceGenerator.identity.version, "fixture-v1");
  assert.match(request.system, /do not infer private reasoning/i);
  assert.match(request.system, /Never increase certainty/i);
  assert.match(request.system, /Required output language: Simplified Chinese/i);
  assert.doesNotMatch(request.input, /provenance|displayOrdinal|rollout|sqlite/i);
  assert.equal(requests.length, 1);
});

test("prompt projection bounds tool-heavy and oversized public content", () => {
  const turn = {
    ...fixtureTurn(),
    input: { text: "i".repeat(10_000), attachments: [] },
    assistantFinal: "a".repeat(10_000),
    tools: Array.from({ length: 100 }, (_, index) => ({
      callId: `call-${index}`,
      name: `tool-${index}`,
      status: index === 3 ? "failed" as const : "completed" as const,
      inputSummary: "x".repeat(2_000),
      outputSummary: "y".repeat(2_000),
    })),
  };
  const parsed = JSON.parse(buildSemanticTraceRequest(turn).input);
  assert.equal(parsed.toolOutcome.total, 100);
  assert.ok(parsed.toolOutcome.omitted >= 88);
  assert.ok(parsed.toolOutcome.items.length <= 12);
  assert.ok(parsed.input.text.length < 4_100);
  assert.ok(parsed.assistantFinal.length < 4_100);
});

function generator(id: string, version: string, text: string): TurnSemanticTraceGenerator & { calls: number } {
  return {
    identity: { id, version, model: "fixture-model" },
    calls: 0,
    async generate() {
      this.calls += 1;
      return { text };
    },
  };
}

function fixtureTurn(): Turn {
  return {
    providerId: "fixture-provider",
    sessionId: "session-1",
    nativeTurnId: "turn-native-1",
    displayOrdinal: 1,
    initiatorKind: "user",
    status: "completed",
    input: { text: "Inspect the adapter.", attachments: [] },
    assistantFinal: "The adapter was inspected without upstream writes.",
    tools: [{ callId: "call-1", name: "read", status: "completed", outputSummary: "Read-only result" }],
    partial: false,
    health: { state: "complete", issues: [] },
    provenance: [{ providerId: "fixture-provider", tier: "primary", completeness: "complete" }],
  };
}
