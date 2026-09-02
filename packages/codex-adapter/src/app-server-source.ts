import { AppServerError, ReadOnlyAppServerClient } from "./app-server-client.ts";
import type { DiagnosticCollector } from "./diagnostics.ts";
import type { CodexThreadRecord, CodexTurnRecord, SourceSnapshot } from "./internal.ts";
import { booleanValue, compactText, isRecord, numberValue, stringValue } from "./internal.ts";

const SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
];

export interface AppServerSourceOptions {
  readonly executable: string;
  readonly codexHome: string;
  readonly diagnostics: DiagnosticCollector;
  readonly timeoutMs?: number;
  readonly mode?: "proxy" | "spawn";
}

export class AppServerSource {
  readonly #options: AppServerSourceOptions;
  serverUserAgent?: string;
  supportsTurnPagination: "yes" | "no" | "unknown" = "unknown";

  constructor(options: AppServerSourceOptions) {
    this.#options = options;
  }

  async list(): Promise<SourceSnapshot> {
    return await this.#withReconnect(async (client) => {
      await client.connect();
      this.serverUserAgent = client.serverUserAgent;
      const [active, archived] = await Promise.all([
        this.#listArchivePageSet(client, false),
        this.#listArchivePageSet(client, true),
      ]);
      return { threads: [...active, ...archived], projects: [] };
    });
  }

  async listTurns(sessionId: string): Promise<readonly CodexTurnRecord[]> {
    return await this.#withReconnect(async (client) => {
      await client.connect();
      this.serverUserAgent = client.serverUserAgent;
      try {
        const turns = await this.#listTurnsPaginated(client, sessionId);
        this.supportsTurnPagination = "yes";
        return turns;
      } catch (error) {
        if (!(error instanceof AppServerError) || !["method_not_found", "version_skew"].includes(error.kind)) throw error;
        this.supportsTurnPagination = "no";
        this.#options.diagnostics.add({ code: "version_skew", severity: "warning", message: "Native turn pagination is unavailable; thread/read fallback was used.", sessionId });
        const result = await client.request("thread/read", { threadId: sessionId, includeTurns: true });
        const thread = isRecord(result) && isRecord(result.thread) ? result.thread : undefined;
        return Array.isArray(thread?.turns) ? projectAppServerTurns(sessionId, thread.turns) : [];
      }
    });
  }

  #client(): ReadOnlyAppServerClient {
    return new ReadOnlyAppServerClient({
      executable: this.#options.executable,
      codexHome: this.#options.codexHome,
      requestTimeoutMs: this.#options.timeoutMs,
      mode: this.#options.mode,
    });
  }

  async #withReconnect<T>(operation: (client: ReadOnlyAppServerClient) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = this.#client();
      try {
        return await operation(client);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof AppServerError && ["transport", "timeout"].includes(error.kind);
        if (!retryable || attempt === 1) throw error;
      } finally {
        await client.close();
      }
    }
    throw lastError;
  }

  async #listArchivePageSet(client: ReadOnlyAppServerClient, archived: boolean): Promise<CodexThreadRecord[]> {
    const output: CodexThreadRecord[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.request("thread/list", {
        cursor: cursor ?? null,
        limit: 100,
        archived,
        sourceKinds: SOURCE_KINDS,
        sortKey: "created_at",
        sortDirection: "asc",
        useStateDbOnly: true,
      });
      if (!isRecord(result)) throw new AppServerError("protocol", "thread/list returned a non-object result");
      if (!Array.isArray(result.data)) throw new AppServerError("protocol", "thread/list result has no data array");
      for (const value of result.data) {
        if (!isRecord(value) || !stringValue(value.id)) continue;
        output.push(projectAppServerThread(value, archived));
      }
      cursor = stringValue(result.nextCursor);
    } while (cursor);
    return output;
  }

  async #listTurnsPaginated(client: ReadOnlyAppServerClient, sessionId: string): Promise<CodexTurnRecord[]> {
    const pages: unknown[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.request("thread/turns/list", {
        threadId: sessionId,
        cursor: cursor ?? null,
        limit: 100,
        sortDirection: "asc",
        itemsView: "full",
      });
      if (!isRecord(result) || !Array.isArray(result.data)) throw new AppServerError("protocol", "thread/turns/list returned an invalid page");
      pages.push(...result.data);
      cursor = stringValue(result.nextCursor);
    } while (cursor);
    return projectAppServerTurns(sessionId, pages);
  }
}

function projectAppServerThread(value: Record<string, unknown>, archived: boolean): CodexThreadRecord {
  const source = sourceString(value.source ?? value.threadSource);
  return {
    id: String(value.id),
    title: stringValue(value.name) ?? stringValue(value.title),
    preview: compactText(value.preview),
    cwd: stringValue(value.cwd),
    observedCwds: stringValue(value.cwd) ? [String(value.cwd)] : [],
    projectId: stringValue(value.projectId),
    createdAtMs: secondsOrMillis(value.createdAt ?? value.created_at),
    updatedAtMs: secondsOrMillis(value.updatedAt ?? value.updated_at),
    archived,
    source,
    historyMode: stringValue(value.historyMode),
    rolloutPaths: [],
    sourceTier: "primary",
    partial: false,
  };
}

export function projectAppServerTurns(sessionId: string, values: readonly unknown[]): CodexTurnRecord[] {
  const result: CodexTurnRecord[] = [];
  for (const raw of values) {
    if (!isRecord(raw)) continue;
    const turnId = stringValue(raw.id) ?? stringValue(raw.turnId);
    if (!turnId) continue;
    const items = Array.isArray(raw.items) ? raw.items : [];
    const projected = projectItems(items);
    result.push({
      sessionId,
      turnId,
      ordinal: result.length + 1,
      status: statusValue(raw.status),
      initiator: projected.inputText || projected.attachments.length ? "user" : "agent",
      inputText: projected.inputText,
      assistantFinal: projected.assistantFinal,
      attachments: projected.attachments,
      tools: projected.tools,
      startedAtMs: secondsOrMillis(raw.startedAt),
      completedAtMs: secondsOrMillis(raw.completedAt),
      sourceTier: "primary",
      partial: statusValue(raw.status) === "partial",
      issues: [],
    });
  }
  return result;
}

function projectItems(items: readonly unknown[]) {
  let inputText: string | undefined;
  let assistantFinal: string | undefined;
  const attachments: { kind: "image" | "file" | "audio" | "unknown"; name?: string; mimeType?: string }[] = [];
  const tools: { callId?: string; name: string; status: "requested" | "completed" | "failed" | "unknown"; inputSummary?: string; outputSummary?: string }[] = [];
  const byCall = new Map<string, number>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    const type = stringValue(item.type) ?? "";
    if (/userMessage/i.test(type)) inputText = contentText(item.content) ?? stringValue(item.text) ?? inputText;
    else if (/agentMessage|assistantMessage/i.test(type)) assistantFinal = contentText(item.content) ?? stringValue(item.text) ?? assistantFinal;
    else if (/commandExecution|fileChange|mcpToolCall|dynamicToolCall|toolCall/i.test(type)) {
      const callId = stringValue(item.id) ?? stringValue(item.callId);
      const tool = {
        callId,
        name: stringValue(item.name) ?? type,
        status: toolStatus(item.status),
        inputSummary: compactText(item.command ?? item.arguments ?? item.input),
        outputSummary: compactText(item.output ?? item.result),
      };
      if (callId) byCall.set(callId, tools.length);
      tools.push(tool);
    } else if (/tool.*output|function.*output/i.test(type)) {
      const callId = stringValue(item.callId);
      const target = callId ? byCall.get(callId) : undefined;
      if (target !== undefined) tools[target] = { ...tools[target]!, status: "completed", outputSummary: compactText(item.output ?? item.result) };
    }
    for (const attachment of attachmentValues(item)) attachments.push(attachment);
  }
  return { inputText, assistantFinal, attachments, tools };
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) if (isRecord(item)) {
    const text = stringValue(item.text ?? item.inputText ?? item.outputText);
    if (text) parts.push(text);
  }
  return parts.length ? parts.join("\n") : undefined;
}

function attachmentValues(item: Record<string, unknown>) {
  const values = Array.isArray(item.content) ? item.content : [];
  return values.filter(isRecord).flatMap((part) => {
    const type = stringValue(part.type) ?? "";
    if (!/image|file|audio/i.test(type)) return [];
    const kind = /image/i.test(type) ? "image" : /audio/i.test(type) ? "audio" : "file";
    return [{ kind: kind as "image" | "file" | "audio", name: stringValue(part.name), mimeType: stringValue(part.mimeType) }];
  });
}

function statusValue(value: unknown): CodexTurnRecord["status"] {
  const raw = typeof value === "string" ? value : isRecord(value) ? stringValue(value.type) : undefined;
  if (/complete|success/i.test(raw ?? "")) return "completed";
  if (/interrupt|abort|cancel/i.test(raw ?? "")) return "interrupted";
  if (/fail|error/i.test(raw ?? "")) return "failed";
  if (/progress|active|running/i.test(raw ?? "")) return "in_progress";
  return "partial";
}

function toolStatus(value: unknown): "requested" | "completed" | "failed" | "unknown" {
  const raw = typeof value === "string" ? value : isRecord(value) ? stringValue(value.type) : undefined;
  if (/complete|success/i.test(raw ?? "")) return "completed";
  if (/fail|error/i.test(raw ?? "")) return "failed";
  if (/progress|start|pending/i.test(raw ?? "")) return "requested";
  return "unknown";
}

function sourceString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const kind = stringValue(value.type) ?? stringValue(value.kind);
  return kind ?? JSON.stringify(value).slice(0, 200);
}

function secondsOrMillis(value: unknown): number | undefined {
  const number = numberValue(value);
  if (number === undefined) return undefined;
  return number < 10_000_000_000 ? number * 1_000 : number;
}
