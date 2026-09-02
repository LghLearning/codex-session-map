import { CodexAdapterV1 } from "../../../packages/codex-adapter/src/index.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const includeHidden = args.includes("--include-hidden");
const disableAppServer = args.includes("--no-app-server");
const appServerMode = args.includes("--spawn-app-server") ? "spawn" as const : "proxy" as const;
const codexBinIndex = args.indexOf("--codex-bin");
const appServerExecutable = codexBinIndex >= 0 ? args[codexBinIndex + 1] : undefined;

const adapter = new CodexAdapterV1({ includeHidden, disableAppServer, appServerExecutable, appServerMode });
const environment = await adapter.getEnvironment();
const scopes = await adapter.listWorkspaceScopes();
const sessionRows: { scopeId: string; sessionCount: number; archivedCount: number; hiddenCount: number; turnSamples: { sessionKey: string; turnCount: number; statuses: Record<string, number>; nativeIds: boolean }[] }[] = [];
let sampled = 0;

for (const scope of scopes) {
  const sessions = await allPages((cursor) => adapter.listSessions(scope.id, cursor));
  const turnSamples: { sessionKey: string; turnCount: number; statuses: Record<string, number>; nativeIds: boolean }[] = [];
  for (const session of sessions) {
    if (sampled >= 5) break;
    const turns = await allPages((cursor) => adapter.listTurns(session.providerSessionId, cursor));
    if (!turns.length) continue;
    sampled += 1;
    turnSamples.push({
      sessionKey: redactId(session.providerSessionId),
      turnCount: turns.length,
      statuses: countBy(turns.map((turn) => turn.status)),
      nativeIds: turns.every((turn) => Boolean(turn.nativeTurnId)),
    });
  }
  sessionRows.push({
    scopeId: redactScopeId(scope.id),
    sessionCount: sessions.length,
    archivedCount: sessions.filter((session) => session.archiveStatus === "archived").length,
    hiddenCount: sessions.filter((session) => session.excludedFromMainWorkspaceForest).length,
    turnSamples,
  });
}

const diagnostics = adapter.getDiagnostics();
const report = {
  environment: {
    platform: `${process.platform} ${process.arch}`,
    backendVersion: environment.backendVersion,
    codexHome: redactPath(environment.codexHome),
    stateDatabase: Boolean(environment.stateDatabase),
    historyDatabase: Boolean(environment.historyDatabase),
    sessionsDirectory: true,
    archivedSessionsDirectory: true,
    appServerRequested: !disableAppServer,
  },
  workspaceScopesCount: scopes.length,
  sessionCount: sessionRows.reduce((sum, row) => sum + row.sessionCount, 0),
  scopes: sessionRows,
  diagnostics: countBy(diagnostics.map((item) => item.code)),
};

if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Codex backend: ${report.environment.backendVersion ?? "unavailable"}`);
  console.log(`Workspace scopes: ${report.workspaceScopesCount}`);
  console.log(`Sessions visible: ${report.sessionCount}`);
  for (const row of report.scopes) console.log(`- ${row.scopeId}: ${row.sessionCount} sessions, ${row.archivedCount} archived, ${row.hiddenCount} hidden; ${row.turnSamples.length} turn samples`);
  console.log(`Diagnostics: ${JSON.stringify(report.diagnostics)}`);
}

async function allPages<T>(load: (cursor?: string) => Promise<{ data: readonly T[]; nextCursor?: string }>): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    result.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}

function countBy(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function redactId(value: string): string {
  return value.length <= 8 ? "<redacted>" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function redactScopeId(value: string): string {
  if (value.startsWith("provider-project:")) return `provider-project:${redactId(value.slice("provider-project:".length))}`;
  return value;
}

function redactPath(value: string): string {
  return value.replace(/^([A-Za-z]:\\Users\\)[^\\]+/i, "$1<user>");
}
