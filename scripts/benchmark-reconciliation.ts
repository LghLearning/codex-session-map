import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { CodexAdapterV1 } from "../packages/codex-adapter/src/adapter.ts";

const adapter = new CodexAdapterV1({ disableAppServer: true });
const environment = await adapter.getEnvironment();
const sourceFiles = [
  ...(await jsonlFiles(environment.sessionsDirectory)),
  ...(await jsonlFiles(environment.archivedSessionsDirectory)),
  ...[environment.stateDatabase, environment.historyDatabase].filter((value): value is string => Boolean(value)),
];
const bytes = (await Promise.all(sourceFiles.map(async (path) => (await stat(path)).size))).reduce((sum, value) => sum + value, 0);
await adapter.listWorkspaceScopes();
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
await adapter.refresh();
const wallMs = performance.now() - wallStart;
const cpu = process.cpuUsage(cpuStart);
const scopes = await adapter.listWorkspaceScopes();
let sessions = 0;
for (const scope of scopes) sessions += (await allPages((cursor) => adapter.listSessions(scope.id, cursor))).length;

console.log(JSON.stringify({
  strategy: "full_rollout_reparse",
  watcherRole: "latency_optimization",
  reconciliationRole: "correctness",
  environment: { node: process.version, backend: environment.backendVersion },
  scopeCount: scopes.length,
  sessionCount: sessions,
  sourceFileCount: sourceFiles.length,
  sourceBytes: bytes,
  wallMs,
  processCpuMs: (cpu.user + cpu.system) / 1_000,
  defaultIntervalMs: 300_000,
}, null, 2));

async function jsonlFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && extname(entry.name) === ".jsonl").map((entry) => join(entry.parentPath, entry.name));
  } catch { return []; }
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
