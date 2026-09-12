import type { SemanticTraceCompletionClient, SemanticTraceCompletionRequest } from "./prompt-generator.ts";

export const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3.5";

export class LocalOllamaError extends Error {
  readonly code: "unavailable" | "model_missing" | "invalid_response" | "thinking_not_disabled";

  constructor(code: LocalOllamaError["code"], message: string) {
    super(message);
    this.name = "LocalOllamaError";
    this.code = code;
  }
}

export interface LocalOllamaCompletionClientOptions {
  readonly endpoint?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Ollama-native runtime adapter. Provider-neutral generator and Core types stay unchanged. */
export class LocalOllamaCompletionClient implements SemanticTraceCompletionClient {
  readonly model: string;
  readonly #modelName: string;
  readonly #endpoint: URL;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  private constructor(options: LocalOllamaCompletionClientOptions, digest?: string) {
    this.#endpoint = localEndpoint(options.endpoint ?? DEFAULT_OLLAMA_ENDPOINT);
    this.#modelName = options.model ?? DEFAULT_OLLAMA_MODEL;
    this.model = digest ? `${this.#modelName}@${digest.slice(0, 16)}` : this.#modelName;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  static async connect(options: LocalOllamaCompletionClientOptions = {}): Promise<LocalOllamaCompletionClient> {
    const provisional = new LocalOllamaCompletionClient(options);
    let response: Response;
    try {
      response = await provisional.#fetch(new URL("/api/tags", provisional.#endpoint), { signal: AbortSignal.timeout(Math.min(provisional.#timeoutMs, 10_000)) });
    } catch (error) {
      throw new LocalOllamaError("unavailable", `Local Ollama is unavailable at ${provisional.#endpoint.origin} (${errorName(error)}).`);
    }
    if (!response.ok) throw new LocalOllamaError("unavailable", `Local Ollama probe failed with HTTP ${response.status}.`);
    const payload = await response.json() as TagsResponse;
    const requested = provisional.#modelName;
    const match = payload.models?.find((entry) => entry.name === requested || entry.name === `${requested}:latest` || entry.model === requested || entry.model === `${requested}:latest`);
    if (!match) throw new LocalOllamaError("model_missing", `Local Ollama model '${requested}' is not installed.`);
    return new LocalOllamaCompletionClient(options, match.digest);
  }

  async complete(request: SemanticTraceCompletionRequest): Promise<string> {
    const format = request.responseJsonSchema ?? request.responseFormat;
    const content = await this.#chat(request.system, request.input, format, request.signal);
    if (content.length <= request.maxOutputCharacters) return content;
    const targetCharacterLimit = Math.min(180, request.maxOutputCharacters);
    const repaired = await this.#chat(
      `${request.system} The previous draft exceeded the hard limit. Compress it to at most ${targetCharacterLimit} characters without changing facts, certainty, subjects, objects, or key relations.`,
      JSON.stringify({ overlongDraft: content, targetCharacterLimit, hardCharacterLimit: request.maxOutputCharacters }),
      format,
      request.signal,
    );
    if (repaired.length > request.maxOutputCharacters) {
      throw new LocalOllamaError("invalid_response", `Ollama exceeded the ${request.maxOutputCharacters}-character limit after one repair attempt.`);
    }
    return repaired;
  }

  async #chat(system: string, input: string, responseFormat?: "json" | Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(new URL("/api/chat", this.#endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          model: this.#modelName,
          stream: false,
          think: false,
          messages: [
            { role: "system", content: system },
            { role: "user", content: input },
          ],
          options: { temperature: 0, num_predict: responseFormat ? 320 : 160 },
          format: responseFormat,
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]) : AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new LocalOllamaError("unavailable", `Local Ollama generation failed (${errorName(error)}).`);
    }
    if (!response.ok) throw new LocalOllamaError("unavailable", `Local Ollama generation failed with HTTP ${response.status}.`);
    const payload = await response.json() as ChatResponse;
    const content = payload.message?.content?.trim();
    const thinking = payload.message?.thinking?.trim();
    if (thinking || /<think(?:ing)?>/i.test(content ?? "")) throw new LocalOllamaError("thinking_not_disabled", "Ollama returned thinking content despite think:false.");
    if (!content) throw new LocalOllamaError("invalid_response", "Ollama returned no generated content.");
    return content;
  }
}

function localEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new LocalOllamaError("unavailable", "The Ollama runtime must use a local HTTP loopback endpoint.");
  }
  return endpoint;
}

function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}

interface TagsResponse {
  readonly models?: readonly { readonly name?: string; readonly model?: string; readonly digest?: string }[];
}

interface ChatResponse {
  readonly message?: { readonly content?: string; readonly thinking?: string };
}
