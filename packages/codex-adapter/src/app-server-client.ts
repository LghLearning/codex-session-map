import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { EventEmitter } from "node:events";

export const READ_ONLY_APP_SERVER_METHODS = new Set([
  "initialize",
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
]);

export type AppServerErrorKind =
  | "timeout"
  | "transport"
  | "protocol"
  | "method_not_found"
  | "version_skew"
  | "server";

export class AppServerError extends Error {
  readonly kind: AppServerErrorKind;
  readonly code?: number;

  constructor(
    kind: AppServerErrorKind,
    message: string,
    code?: number,
  ) {
    super(message);
    this.name = "AppServerError";
    this.kind = kind;
    this.code = code;
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface AppServerClientOptions {
  readonly executable: string;
  readonly codexHome?: string;
  readonly requestTimeoutMs?: number;
  readonly clientVersion?: string;
  readonly mode?: "proxy" | "spawn";
}

export class ReadOnlyAppServerClient extends EventEmitter {
  readonly #options: AppServerClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  #process?: ChildProcessWithoutNullStreams;
  #reader?: ReadlineInterface;
  #nextId = 1;
  #closed = false;
  #initialized = false;
  serverUserAgent?: string;

  constructor(options: AppServerClientOptions) {
    super();
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#process && !this.#process.killed && this.#initialized) return;
    this.#closed = false;
    const env = { ...process.env };
    if (this.#options.codexHome) env.CODEX_HOME = this.#options.codexHome;
    const args = this.#options.mode === "spawn" ? ["app-server", "--listen", "stdio://"] : ["app-server", "proxy"];
    const child = spawn(this.#options.executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    this.#process = child;
    this.#reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#reader.on("line", (line) => this.#handleLine(line));
    child.on("error", (error) => this.#rejectAll(new AppServerError("transport", error.message)));
    child.on("exit", (code) => {
      this.#initialized = false;
      if (!this.#closed) this.#rejectAll(new AppServerError("transport", `app-server exited with code ${code ?? "unknown"}`));
    });

    const result = await this.request("initialize", {
      clientInfo: { name: "codex-session-map", version: this.#options.clientVersion ?? "0.1.0-c1" },
      capabilities: { experimentalApi: true },
    });
    if (isRecord(result)) this.serverUserAgent = typeof result.userAgent === "string" ? result.userAgent : undefined;
    this.#notify("initialized", {});
    this.#initialized = true;
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    assertReadOnlyMethod(method);
    if (method !== "initialize" && !this.#initialized) await this.connect();
    if (!this.#process || this.#process.stdin.destroyed) throw new AppServerError("transport", "app-server stdin is unavailable");
    const id = this.#nextId++;
    const timeoutMs = this.#options.requestTimeoutMs ?? 8_000;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppServerError("timeout", `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#process!.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new AppServerError("transport", error.message));
      });
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#initialized = false;
    this.#reader?.close();
    this.#rejectAll(new AppServerError("transport", "app-server client closed"));
    this.#process?.kill();
    this.#process = undefined;
  }

  #notify(method: string, params: Record<string, unknown>): void {
    this.#process?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  #handleLine(line: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      this.emit("protocolWarning", new AppServerError("protocol", "app-server emitted non-JSON stdout"));
      return;
    }
    if (!isRecord(payload)) return;
    if (typeof payload.method === "string" && payload.id === undefined) {
      this.emit("notification", payload);
      return;
    }
    if (typeof payload.id !== "number") return;
    const pending = this.#pending.get(payload.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(payload.id);
    if (isRecord(payload.error)) {
      const code = typeof payload.error.code === "number" ? payload.error.code : undefined;
      const message = typeof payload.error.message === "string" ? payload.error.message : "Unknown app-server error";
      pending.reject(classifyRpcError(pending.method, code, message));
      return;
    }
    pending.resolve(payload.result);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export function assertReadOnlyMethod(method: string): void {
  if (!READ_ONLY_APP_SERVER_METHODS.has(method)) {
    throw new AppServerError("protocol", `Blocked non-read-only app-server method: ${method}`);
  }
}

function classifyRpcError(method: string, code: number | undefined, message: string): AppServerError {
  if (code === -32601 || /unsupported|not found/i.test(message)) return new AppServerError("method_not_found", `${method}: ${message}`, code);
  if (/version|capabilit|experimental/i.test(message)) return new AppServerError("version_skew", `${method}: ${message}`, code);
  return new AppServerError("server", `${method}: ${message}`, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
