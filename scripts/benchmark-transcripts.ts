import { performance } from "node:perf_hooks";
import { CodexAdapterV1 } from "../packages/codex-adapter/src/index.ts";
import type { Session, Turn } from "../packages/core/src/index.ts";

const adapter = new CodexAdapterV1({ disableAppServer: true, includeHidden: false, pageSize: 200 });
const processCpuStart = process.cpuUsage();
const processStartedAt = performance.now();
const initialStartedAt = performance.now();
const scopes = await adapter.listWorkspaceScopes();
const initialLoadMs = performance.now() - initialStartedAt;
const sessions: Session[] = [];
for (const scope of scopes) sessions.push(...await allPages((cursor) => adapter.listSessions(scope.id, cursor)));

const rows = [];
for (const session of sessions) {
  const startedAt = performance.now();
  const turns = await allPages((cursor) => adapter.listTurns(session.providerSessionId, cursor));
  rows.push({
    session,
    turns,
    loadMs: performance.now() - startedAt,
    tools: turns.reduce((sum, turn) => sum + turn.tools.length, 0),
    items: turns.reduce((sum, turn) => sum + 1 + Number(Boolean(turn.input.text)) + Number(Boolean(turn.assistantFinal)) + turn.input.attachments.length + turn.tools.length, 0),
    contentChars: estimatedContentChars(turns),
  });
}

const nonEmpty = rows.filter((row) => row.turns.length > 0);
const candidates = [
  ["small", nearest(nonEmpty, 10)],
  ["medium", nearest(nonEmpty, 50)],
  ["large", nearest(nonEmpty.filter((row) => row.turns.length >= 100), 100) ?? largest(nonEmpty)],
  ["longest", largest(nonEmpty)],
  ["tool-heavy", [...nonEmpty].sort((a, b) => b.tools - a.tools)[0]],
].filter((entry) => entry[1]);
const cpu = process.cpuUsage(processCpuStart);

console.log(JSON.stringify({
  environment: {
    node: process.version,
    scopes: scopes.length,
    sessions: sessions.length,
    initialLoadMs: round(initialLoadMs),
    fullScanWallMs: round(performance.now() - processStartedAt),
    processCpuMs: round((cpu.user + cpu.system) / 1_000),
  },
  candidates: candidates.map(([classification, row]) => ({
    classification,
    sessionId: row.session.providerSessionId,
    scopeId: row.session.workspaceScopeId,
    turns: row.turns.length,
    tools: row.tools,
    items: row.items,
    contentChars: row.contentChars,
    adapterTurnLoadMs: round(row.loadMs),
    middleTurnId: row.turns[Math.floor(row.turns.length / 2)]?.nativeTurnId,
  })),
}, null, 2));

function nearest<T extends { turns: readonly unknown[] }>(values: readonly T[], target: number): T | undefined {
  return [...values].sort((a, b) => Math.abs(a.turns.length - target) - Math.abs(b.turns.length - target))[0];
}

function largest<T extends { turns: readonly unknown[] }>(values: readonly T[]): T | undefined {
  return [...values].sort((a, b) => b.turns.length - a.turns.length)[0];
}

function estimatedContentChars(turns: readonly Turn[]): number {
  return turns.reduce((sum, turn) => sum
    + (turn.input.text?.length ?? 0)
    + (turn.assistantFinal?.length ?? 0)
    + turn.tools.reduce((toolSum, tool) => toolSum + (tool.inputSummary?.length ?? 0) + (tool.outputSummary?.length ?? 0), 0), 0);
}

async function allPages<T>(load: (cursor?: string) => Promise<{ data: readonly T[]; nextCursor?: string }>): Promise<T[]> {
  const values: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    values.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

function round(value: number): number { return Math.round(value * 100) / 100; }
