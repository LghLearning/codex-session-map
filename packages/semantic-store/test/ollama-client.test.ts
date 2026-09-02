import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalOllamaCompletionClient,
  LocalOllamaError,
  type SemanticTraceCompletionRequest,
} from "../src/index.ts";

const request: SemanticTraceCompletionRequest = { system: "Return one line.", input: "fixture", maxOutputCharacters: 240 };

test("Ollama native client pins model digest and sends think:false", async () => {
  const requests: { url: string; body?: any }[] = [];
  const client = await LocalOllamaCompletionClient.connect({
    model: "qwen3.5",
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/api/tags")) return json({ models: [{ name: "qwen3.5:latest", digest: "0123456789abcdefcafebabe" }] });
      return json({ message: { content: "A faithful one-line trace.", thinking: "" }, done: true });
    },
  });
  assert.equal(client.model, "qwen3.5@0123456789abcdef");
  assert.equal(await client.complete(request), "A faithful one-line trace.");
  assert.equal(requests[1]?.body.think, false);
  assert.equal(requests[1]?.body.stream, false);
  assert.equal(requests[1]?.body.options.temperature, 0);
});

test("Ollama native client forwards provider-neutral JSON response format", async () => {
  const bodies: any[] = [];
  const client = await LocalOllamaCompletionClient.connect({ fetch: async (input, init) => {
    if (String(input).endsWith("/api/tags")) return json({ models: [{ name: "qwen3.5:latest", digest: "digest" }] });
    bodies.push(JSON.parse(String(init?.body)));
    return json({ message: { content: '{"relation":"root"}', thinking: "" } });
  } });
  await client.complete({ ...request, responseFormat: "json" });
  assert.equal(bodies[0]?.format, "json");
  assert.equal(bodies[0]?.options.num_predict, 320);
});

test("Ollama native client forwards a provider-neutral JSON schema", async () => {
  const bodies: any[] = [];
  const client = await LocalOllamaCompletionClient.connect({ fetch: async (input, init) => {
    if (String(input).endsWith("/api/tags")) return json({ models: [{ name: "qwen3.5:latest", digest: "digest" }] });
    bodies.push(JSON.parse(String(init?.body)));
    return json({ message: { content: '{"relation":"root"}', thinking: "" } });
  } });
  const schema = { type: "object", properties: { relation: { type: "string" } } };
  await client.complete({ ...request, responseJsonSchema: schema });
  assert.deepEqual(bodies[0]?.format, schema);
});

test("Ollama client fails closed when thinking is returned", async () => {
  const client = await LocalOllamaCompletionClient.connect({ fetch: responseSequence(
    { models: [{ name: "qwen3.5:latest", digest: "digest" }] },
    { message: { content: "trace", thinking: "private reasoning" } },
  ) });
  await assert.rejects(() => client.complete(request), (error) => error instanceof LocalOllamaError && error.code === "thinking_not_disabled");
});

test("Ollama client makes one local repair attempt for an overlong trace", async () => {
  const bodies: any[] = [];
  const client = await LocalOllamaCompletionClient.connect({ fetch: async (input, init) => {
    if (String(input).endsWith("/api/tags")) return json({ models: [{ name: "qwen3.5:latest", digest: "digest" }] });
    bodies.push(JSON.parse(String(init?.body)));
    return json({ message: { content: bodies.length === 1 ? "x".repeat(241) : "Short repaired trace.", thinking: "" } });
  } });
  assert.equal(await client.complete(request), "Short repaired trace.");
  assert.equal(bodies.length, 2);
  assert.equal(bodies.every((body) => body.think === false), true);
});

test("Ollama client reports missing runtime and model without remote fallback", async () => {
  await assert.rejects(
    () => LocalOllamaCompletionClient.connect({ fetch: async () => { throw new Error("connection refused"); } }),
    (error) => error instanceof LocalOllamaError && error.code === "unavailable",
  );
  await assert.rejects(
    () => LocalOllamaCompletionClient.connect({ fetch: async () => json({ models: [] }) }),
    (error) => error instanceof LocalOllamaError && error.code === "model_missing",
  );
});

function responseSequence(...values: unknown[]): typeof fetch {
  let index = 0;
  return async () => json(values[index++]);
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
