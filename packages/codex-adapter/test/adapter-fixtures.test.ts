import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CodexAdapterV1 } from "../src/adapter.ts";
import { projectAppServerTurns } from "../src/app-server-source.ts";
import { compactText } from "../src/internal.ts";

test("App Server preserves full message bodies while tool and list previews stay bounded", () => {
  const body = `  # 结果\n\n${"背景。".repeat(220)}\n\n\`\`\`ts\n  return 42;\n\`\`\`\n最终结论：采用方案 B。\n`;
  const records = projectAppServerTurns("full-content", [
    null,
    { id: "native/one", status: "completed", items: [
      { type: "userMessage", content: [{ type: "inputText", text: body }] },
      { type: "agentMessage", text: body },
      { type: "commandExecution", id: "tool", command: body, output: body, status: "completed" },
    ] },
    { status: "completed" },
    { id: "native/two", status: "completed", items: [
      { type: "userMessage", text: body },
      { type: "agentMessage", content: body },
    ] },
    { id: "native/three", status: "completed", items: [
      { type: "userMessage", content: body },
      { type: "agentMessage", content: [{ text: body }, { outputText: body }] },
    ] },
  ]);
  assert.deepEqual(records.map((record) => record.ordinal), [1, 2, 3]);
  assert.ok(records.every((record) => record.inputText === body));
  assert.equal(records[0].assistantFinal, body);
  assert.equal(records[1].assistantFinal, body);
  assert.equal(records[2].assistantFinal, `${body}\n${body}`);
  assert.equal(records[0].tools[0].inputSummary, compactText(body));
  assert.equal(records[0].tools[0].outputSummary?.length, 500);
  assert.equal(compactText(body)?.length, 500);
  assert.equal(compactText(body)?.includes("\n"), false);
});

test("rollout bodies stay complete and native-ID reads agree with cross-segment pagination", async () => {
  const home = await fixtureHome();
  const directory = join(home, "sessions", "full-content");
  await mkdir(directory, { recursive: true });
  const body = `\n# 原文\n${"详细背景。".repeat(150)}\n  保留缩进\n最终结论\n`;
  const events = [
    { type: "session_meta", payload: { id: "long-session", cwd: "C:\\FullContent", source: "cli" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "native/一%" } },
    { type: "event_msg", payload: { type: "user_message", message: body } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "native/一%", last_agent_message: body } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "native-two" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: body }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: body }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "native-two" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "native-three" } },
    { type: "response_item", payload: { type: "message", role: "user", content: body } },
    { type: "event_msg", payload: { type: "agent_message", message: body } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "native-three" } },
  ];
  const path = join(directory, "long.jsonl");
  const source = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(path, source);
  const adapter = new CodexAdapterV1({ codexHome: home, disableAppServer: true, pageSize: 1 });
  const turns = await allPages((cursor) => adapter.listTurns("long-session", cursor));
  assert.deepEqual(turns.map((turn) => turn.displayOrdinal), [1, 2, 3]);
  assert.ok(turns.every((turn) => turn.input.text === body && turn.assistantFinal === body));
  for (const turn of turns) assert.deepEqual(await adapter.readTurn("long-session", turn.nativeTurnId), turn);
  assert.equal(await adapter.readTurn("long-session", "1"), undefined, "display ordinal is not a native ID");
  assert.equal(await adapter.readTurn("session-modern", "native/一%"), undefined, "lookup is Session-scoped");
  const segmented = await allPages((cursor) => adapter.listTurns("session-modern", cursor));
  assert.deepEqual(segmented.map((turn) => turn.displayOrdinal), [1, 2, 3, 4]);
  assert.deepEqual(await adapter.readTurn("session-modern", "turn-second-segment"), segmented[3]);
  assert.equal((await adapter.readSession("long-session")).title.length, 500);
  assert.equal(await readFile(path, "utf8"), source, "reading never modifies the rollout");
});

test("rollout fallback satisfies C1 session, segment, turn, archive and hidden-agent gates", async () => {
  const home = await fixtureHome();
  const adapter = new CodexAdapterV1({ codexHome: home, disableAppServer: true, pageSize: 2 });
  const scopes = await adapter.listWorkspaceScopes();
  const sessions = (await Promise.all(scopes.map((scope) => allPages((cursor) => adapter.listSessions(scope.id, cursor))))).flat();

  const modernMatches = sessions.filter((session) => session.providerSessionId === "session-modern");
  assert.equal(modernMatches.length, 1, "multiple physical segments must become one session");
  assert.equal(modernMatches[0]?.provenance.find((item) => item.tier === "reconciliation")?.physicalRecordCount, 2);

  const turns = await allPages((cursor) => adapter.listTurns("session-modern", cursor));
  assert.deepEqual(turns.map((turn) => turn.nativeTurnId), ["turn-completed", "turn-interrupted", "turn-failed", "turn-second-segment"]);
  assert.deepEqual(turns.map((turn) => turn.status), ["completed", "interrupted", "failed", "completed"]);
  assert.equal(turns[0]?.tools[0]?.callId, "call-1");
  assert.equal(turns[0]?.tools[0]?.status, "completed");
  const legacyTurns = await allPages((cursor) => adapter.listTurns("session-legacy", cursor));
  assert.equal(legacyTurns.length, 2, "legacy user messages must establish deterministic recovered boundaries");
  assert.equal(legacyTurns.every((turn) => turn.nativeTurnId.startsWith("recovered:")), true);

  assert.equal(sessions.some((session) => session.providerSessionId === "session-archived" && session.archiveStatus === "archived"), true);
  assert.equal(sessions.some((session) => session.providerSessionId === "session-subagent"), false, "hidden agents stay out of the default forest");
  assert.equal((await adapter.readSession("session-subagent")).excludedFromMainWorkspaceForest, true);
  assert.deepEqual(await adapter.getNativeLineage("session-subagent"), {
    providerId: "codex",
    sessionId: "session-subagent",
    parentSessionId: "session-modern",
    kind: "subagent_spawn",
    recovery: "session_only",
  });
  assert.equal((await adapter.readSession("session-cwd-change")).workspaceScopeId, "ambiguous");
  assert.equal(adapter.getDiagnostics().some((item) => item.code === "multi_segment_session" && item.sessionId === "session-modern"), true);
  assert.equal(adapter.getDiagnostics().some((item) => item.code === "partial_line"), true);
  assert.equal(adapter.getDiagnostics().some((item) => item.code === "unknown_event"), true);
});

test("hidden agent sessions remain enumerable in diagnostics mode", async () => {
  const adapter = new CodexAdapterV1({ codexHome: await fixtureHome(), disableAppServer: true, includeHidden: true });
  const scopes = await adapter.listWorkspaceScopes();
  const sessions = (await Promise.all(scopes.map((scope) => allPages((cursor) => adapter.listSessions(scope.id, cursor))))).flat();
  assert.equal(sessions.some((session) => session.providerSessionId === "session-subagent" && session.excludedFromMainWorkspaceForest), true);
});

async function fixtureHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-map-fixture-"));
  const source = new URL("../../../tests/fixtures/codex-home/", import.meta.url);
  await cp(source, root, { recursive: true });
  const fragment = (await readFile(new URL("../../../tests/fixtures/partial-tail.fragment", import.meta.url), "utf8")).trimEnd();
  const target = join(root, "sessions", "2026", "01", "06");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "rollout-partial.jsonl"), fragment);
  return root;
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
