import assert from "node:assert/strict";
import test from "node:test";
import { AppServerError, assertReadOnlyMethod, READ_ONLY_APP_SERVER_METHODS } from "../src/app-server-client.ts";
import { projectAppServerTurns } from "../src/app-server-source.ts";

test("App-server runtime allowlist rejects every mutating lifecycle method", () => {
  for (const method of ["thread/resume", "thread/fork", "thread/archive", "thread/delete", "thread/name/set", "thread/metadata/update"]) {
    assert.throws(() => assertReadOnlyMethod(method), (error: unknown) => error instanceof AppServerError && /Blocked/.test(error.message));
  }
  assert.deepEqual([...READ_ONLY_APP_SERVER_METHODS].sort(), ["initialize", "thread/items/list", "thread/list", "thread/read", "thread/turns/list"].sort());
});

test("Native app-server turn ids and tool ownership survive projection", () => {
  const turns = projectAppServerTurns("session", [{
    id: "native-turn-id",
    status: "completed",
    items: [
      { type: "userMessage", content: [{ type: "inputText", text: "Input" }] },
      { type: "dynamicToolCall", id: "call", name: "tool", status: "completed", input: "x", output: "y" },
      { type: "agentMessage", content: [{ type: "outputText", text: "Done" }] },
    ],
  }]);
  assert.equal(turns[0]?.turnId, "native-turn-id");
  assert.equal(turns[0]?.status, "completed");
  assert.equal(turns[0]?.tools[0]?.name, "tool");
});
