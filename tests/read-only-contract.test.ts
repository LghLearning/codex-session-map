import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { assertReadOnlyMethod } from "../packages/codex-adapter/src/app-server-client.ts";

test("adapter source contains no Codex upstream write SQL or filesystem writer", async () => {
  const root = new URL("../packages/codex-adapter/src/", import.meta.url);
  const files = await readdir(root);
  const source = (await Promise.all(files.filter((name) => name.endsWith(".ts")).map((name) => readFile(new URL(name, root), "utf8")))).join("\n");
  assert.equal(/\b(?:UPDATE|INSERT|DELETE)\s+(?:threads|thread_turns|thread_items)\b/i.test(source), false);
  assert.equal(/(?:writeFile|appendFile|rename|unlink)\s*\(/.test(source), false);
  assert.match(source, /readOnly:\s*true/);
  assert.match(source, /useStateDbOnly:\s*true/);
});

test("read methods are accepted while mutations are blocked", () => {
  for (const method of ["thread/list", "thread/read", "thread/turns/list", "thread/items/list"]) assert.doesNotThrow(() => assertReadOnlyMethod(method));
  assert.throws(() => assertReadOnlyMethod("thread/archive"));
});
