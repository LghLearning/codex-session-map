import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DiagnosticCollector } from "./diagnostics.ts";
import type { CodexThreadRecord, CodexToolRecord, CodexTurnRecord, SourceSnapshot } from "./internal.ts";
import { compactText, isRecord, stringValue } from "./internal.ts";
import { digest, legacyRecoveredTurnId, recoveredTurnId, stableRolloutFileIdentity, stableSegmentIdentity, type TurnIdentityAlias } from "./turn-identity.ts";
import { RolloutSourceRegistry, type RolloutRegistryFileInput } from "./rollout-registry.ts";

const DECODER_VERSION = 2;
const PROBE_BYTES = 4 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface RolloutCheckpoint {
  readonly decoderVersion: number;
  readonly observedEof: number;
  readonly committedOffset: number;
  readonly physicalLineCount: number;
  readonly headHash: string;
  readonly tailOffset: number;
  readonly tailHash: string;
  readonly identityPrefixHash?: string;
}

export interface DecodedRecord {
  readonly ordinal: number;
  readonly value: Record<string, unknown>;
}

export interface DecodedRollout {
  readonly records: readonly DecodedRecord[];
  readonly checkpoint: RolloutCheckpoint;
  readonly identityPrefixHash: string;
  readonly mode: "full" | "append";
  readonly partialTail: boolean;
  /** Bytes read from disk for this decode (full file or append range). */
  readonly bytesRead: number;
}

export interface RolloutRefreshStats {
  readonly filesScanned: number;
  readonly filesDecodedFull: number;
  readonly filesDecodedAppend: number;
  readonly bytesRead: number;
  readonly affectedPaths: readonly string[];
  readonly affectedSessionIds: readonly string[];
  readonly refreshMs: number;
}

export interface RolloutRefreshResult {
  readonly snapshot: SourceSnapshot;
  readonly changed: boolean;
  readonly affectedSessionIds: readonly string[];
  readonly deletedSessionIds: readonly string[];
  readonly stats: RolloutRefreshStats;
}

export interface RolloutSourceOptions {
  readonly codexHome: string;
  readonly diagnostics: DiagnosticCollector;
  readonly registryPath?: string;
}

interface Segment {
  readonly path: string;
  readonly archived: boolean;
  readonly records: readonly DecodedRecord[];
  readonly partial: boolean;
  readonly sessionId: string;
  readonly segmentIdentity: string;
  readonly registryFileId: string;
}

interface FileState {
  readonly path: string;
  readonly archived: boolean;
  readonly decoded: DecodedRollout;
  readonly sessionIds: ReadonlySet<string>;
  readonly registryFileId: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sourceStamp: string;
  readonly contentStamp: string;
}

export class RolloutCodexSource {
  readonly #options: RolloutSourceOptions;
  readonly #segments = new Map<string, Segment[]>();
  readonly #registry?: RolloutSourceRegistry;
  #files = new Map<string, FileState>();
  #snapshot?: SourceSnapshot;

  constructor(options: RolloutSourceOptions) {
    this.#options = options;
    this.#registry = options.registryPath ? new RolloutSourceRegistry(options.registryPath) : undefined;
  }

  async list(): Promise<SourceSnapshot> {
    return (await this.refresh()).snapshot;
  }

  /** Reconciles rollout files while reusing unchanged decoded files in memory. */
  async refresh(changedPaths?: readonly string[]): Promise<RolloutRefreshResult> {
    const started = Date.now();
    const initial = !this.#snapshot;
    const roots = [
      { path: join(this.#options.codexHome, "sessions"), archived: false },
      { path: join(this.#options.codexHome, "archived_sessions"), archived: true },
    ];
    const paths = (await Promise.all(roots.map((root) => walkJsonl(root.path)))).flat();
    const current = new Map(paths.map((path) => [pathKey(path), { path, archived: pathKey(path).startsWith(pathKey(roots[1]!.path)) }]));
    const hinted = new Set((changedPaths ?? []).map(pathKey));
    const inspectAll = initial;
    const files = new Map(this.#files);
    const affectedPaths = new Set<string>();
    const affectedSessions = new Set<string>();
    let filesDecodedFull = 0;
    let filesDecodedAppend = 0;
    let bytesRead = 0;
    for (const [key, entry] of current) {
      const previous = files.get(key);
      const inspect = inspectAll || changedPaths === undefined || hinted.has(key) || !previous;
      if (!inspect && previous) continue;
      const observed = await stat(entry.path).catch(() => undefined);
      if (!observed) continue;
      if (previous && !initial && !hinted.has(key) && observed.size === previous.size && observed.mtimeMs === previous.mtimeMs && changedPaths !== undefined) continue;
      // A concrete watcher hint is authoritative enough to decode the file even
      // when its size and timestamp have not changed (some filesystems have
      // coarse timestamp resolution). Periodic scans may use the cheap probe.
      if (previous && changedPaths === undefined && observed.size === previous.size && observed.mtimeMs === previous.mtimeMs && await probeUnchanged(entry.path, previous.decoded.checkpoint)) continue;
      try {
        const decoded = await decodeRollout(entry.path, previous?.decoded.checkpoint, this.#options.diagnostics);
        bytesRead += decoded.bytesRead;
        if (decoded.mode === "append" && previous) filesDecodedAppend += 1;
        else filesDecodedFull += 1;
        const combined = decoded.mode === "append" && previous
          ? { ...decoded, records: [...previous.decoded.records, ...decoded.records], mode: "append" as const, partialTail: decoded.partialTail }
          : decoded;
        const ids = extractSessionIds(combined.records);
        if (!ids.length) {
          this.#options.diagnostics.add({ code: "orphan_rollout", severity: "warning", message: "A rollout has no usable session metadata id.", sourceKey: basename(entry.path) });
          files.delete(key);
          affectedPaths.add(entry.path);
          if (previous) for (const sessionId of previous.sessionIds) affectedSessions.add(sessionId);
          continue;
        }
        if (ids.length > 1) this.#options.diagnostics.add({ code: "duplicate_metadata_id", severity: "warning", message: "A rollout contains repeated or conflicting session metadata.", sourceKey: basename(entry.path) });
        const registryFileId = stableRolloutFileIdentity(ids, combined.identityPrefixHash);
        const sourceStamp = digest(["rollout-source-v1", String(combined.checkpoint.observedEof), combined.checkpoint.headHash, combined.checkpoint.tailHash, combined.checkpoint.identityPrefixHash ?? ""]);
        const contentStamp = decodedContentStamp(combined);
        const contentChanged = !previous || previous.contentStamp !== contentStamp || previous.archived !== entry.archived;
        files.set(key, { path: entry.path, archived: entry.archived, decoded: combined, sessionIds: new Set(ids), registryFileId, size: observed.size, mtimeMs: observed.mtimeMs, sourceStamp, contentStamp });
        if (contentChanged) {
          affectedPaths.add(entry.path);
          for (const sessionId of ids) affectedSessions.add(sessionId);
          if (previous) for (const sessionId of previous.sessionIds) affectedSessions.add(sessionId);
        }
      } catch {
        this.#options.diagnostics.add({ code: "corrupt_line", severity: "error", message: "A rollout could not be opened or decoded.", sourceKey: basename(entry.path) });
      }
    }
    for (const [key, previous] of this.#files) {
      if (current.has(key)) continue;
      files.delete(key);
      affectedPaths.add(previous.path);
      for (const sessionId of previous.sessionIds) affectedSessions.add(sessionId);
    }
    const segments = buildSegments(files);
    const threads: CodexThreadRecord[] = [];
    for (const [sessionId, sessionSegments] of segments) {
      const ordered = sessionSegments.slice().sort(compareSegments);
      if (ordered.length > 1) this.#options.diagnostics.add({ code: "multi_segment_session", severity: "info", message: `One logical session aggregates ${ordered.length} rollout segments.`, sessionId });
      threads.push(projectSegments(sessionId, ordered));
    }
    const snapshot: SourceSnapshot = { threads, projects: [] };
    const previousIds = new Set(this.#snapshot?.threads.map((thread) => thread.id) ?? []);
    const nextIds = new Set(threads.map((thread) => thread.id));
    const deletedSessionIds = [...previousIds].filter((id) => !nextIds.has(id));
    const changed = initial || deletedSessionIds.length > 0 || affectedPaths.size > 0;
    if (changed) await this.#registry?.reconcile(await registryInputs(files, segments));
    this.#files = files;
    this.#segments.clear();
    for (const [sessionId, sessionSegments] of segments) this.#segments.set(sessionId, sessionSegments);
    this.#snapshot = snapshot;
    return {
      snapshot,
      changed,
      affectedSessionIds: [...affectedSessions].filter((id) => nextIds.has(id)),
      deletedSessionIds,
      stats: { filesScanned: paths.length, filesDecodedFull, filesDecodedAppend, bytesRead, affectedPaths: [...affectedPaths], affectedSessionIds: [...affectedSessions], refreshMs: Date.now() - started },
    };
  }

  async listTurns(sessionId: string, knownPaths: readonly string[] = []): Promise<readonly CodexTurnRecord[]> {
    let segments = this.#segments.get(sessionId);
    if (!segments && knownPaths.length) {
      segments = [];
      for (const path of knownPaths) {
        try {
          const decoded = await decodeRollout(path, undefined, this.#options.diagnostics);
          segments.push({ path, archived: path.toLocaleLowerCase("en-US").includes("archived_sessions"), records: decoded.records, partial: decoded.partialTail, sessionId, segmentIdentity: stableSegmentIdentity(sessionId, decoded.identityPrefixHash), registryFileId: stableRolloutFileIdentity([sessionId], decoded.identityPrefixHash) });
        } catch {
          this.#options.diagnostics.add({ code: "corrupt_line", severity: "error", message: "A registered rollout could not be decoded.", sessionId, sourceKey: basename(path) });
        }
      }
    }
    if (!segments?.length) return [];
    return projectRolloutTurns(sessionId, segments.slice().sort(compareSegments), this.#options.diagnostics);
  }

  segmentCount(sessionId: string): number {
    return this.#segments.get(sessionId)?.length ?? 0;
  }

  listTurnIdentityAliases(): readonly TurnIdentityAlias[] {
    const aliases: TurnIdentityAlias[] = [];
    for (const [sessionId, segments] of this.#segments) projectRolloutTurns(sessionId, segments.slice().sort(compareSegments), this.#options.diagnostics, aliases);
    return aliases;
  }
}

function buildSegments(files: ReadonlyMap<string, FileState>): Map<string, Segment[]> {
  const segments = new Map<string, Segment[]>();
  for (const file of files.values()) {
    for (const sessionId of file.sessionIds) {
      const values = segments.get(sessionId) ?? [];
      values.push({
        path: file.path,
        archived: file.archived,
        records: file.decoded.records,
        partial: file.decoded.partialTail,
        sessionId,
        segmentIdentity: stableSegmentIdentity(sessionId, file.decoded.identityPrefixHash),
        registryFileId: file.registryFileId,
      });
      segments.set(sessionId, values);
    }
  }
  return segments;
}

function extractSessionIds(records: readonly DecodedRecord[]): string[] {
  const metadata = records.filter((record) => record.value.type === "session_meta" && isRecord(record.value.payload));
  return [...new Set(metadata.map((record) => stringValue((record.value.payload as Record<string, unknown>).id)).filter((id): id is string => Boolean(id)))];
}

function decodedContentStamp(decoded: DecodedRollout): string {
  return digest(decoded.records.map((record) => `${record.ordinal}:${JSON.stringify(record.value)}`));
}

function pathKey(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

async function probeUnchanged(path: string, checkpoint: RolloutCheckpoint): Promise<boolean> {
  try {
    const handle = await open(path, "r");
    try {
      const size = (await handle.stat()).size;
      if (size !== checkpoint.observedEof) return false;
      const head = await readWindow(handle, 0, Math.min(PROBE_BYTES, size));
      const tailOffset = Math.max(0, size - PROBE_BYTES);
      const tail = await readWindow(handle, tailOffset, size - tailOffset);
      return hash(head) === checkpoint.headHash && hash(tail) === checkpoint.tailHash;
    } finally { await handle.close(); }
  } catch { return false; }
}

async function registryInputs(
  files: ReadonlyMap<string, FileState>,
  segmentsBySession: ReadonlyMap<string, readonly Segment[]>,
): Promise<RolloutRegistryFileInput[]> {
  const inputs: RolloutRegistryFileInput[] = [];
  for (const file of files.values()) {
    const segments: RolloutRegistryFileInput["sessions"] = [];
    for (const [sessionId, sessionSegments] of segmentsBySession) {
      const ordered = sessionSegments.slice().sort(compareSegments);
      ordered.forEach((segment, segmentOrder) => {
        if (segment.path === file.path) segments.push({ sessionId, stableSegmentIdentity: segment.segmentIdentity, segmentOrder });
      });
    }
    const fileStat = await stat(file.path).catch(() => undefined);
    const checkpoint = file.decoded.checkpoint;
    inputs.push({
      registryFileId: file.registryFileId,
      canonicalPath: file.path,
      rootKind: file.archived ? "archived" : "active",
      stableFileIdentity: file.registryFileId,
      size: checkpoint.observedEof,
      mtimeMs: fileStat?.mtimeMs ?? 0,
      sourceStamp: file.sourceStamp,
      checkpoint,
      sessions: segments,
    });
  }
  return inputs;
}

export async function decodeRollout(path: string, checkpoint: RolloutCheckpoint | undefined, diagnostics: DiagnosticCollector): Promise<DecodedRollout> {
  const handle = await open(path, "r");
  try {
    const observedEof = (await handle.stat()).size;
    const append = checkpoint && checkpoint.decoderVersion === DECODER_VERSION && observedEof > checkpoint.observedEof && await checkpointMatches(handle, checkpoint);
    const start = append ? checkpoint.committedOffset : 0;
    const baseLine = append ? checkpoint.physicalLineCount : 0;
    const length = observedEof - start;
    const bytes = Buffer.alloc(length);
    if (length) await handle.read(bytes, 0, length, start);
    const lastNewline = bytes.lastIndexOf(0x0a);
    const committed = lastNewline >= 0 ? bytes.subarray(0, lastNewline + 1) : Buffer.alloc(0);
    const partialTail = committed.length !== bytes.length;
    const lines = committed.toString("utf8").split("\n");
    lines.pop();
    const records: DecodedRecord[] = [];
    let firstMetaHash: string | undefined;
    let firstBoundaryHash: string | undefined;
    let firstCommittedRecordHash: string | undefined;
    for (const [index, raw] of lines.entries()) {
      const ordinal = baseLine + index + 1;
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        diagnostics.add({ code: "corrupt_line", severity: "warning", message: "A committed rollout line exceeded the decoder limit.", sourceKey: basename(path), ordinal });
        continue;
      }
      try {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value)) throw new Error("record is not an object");
        const rawHash = digest([line]);
        firstCommittedRecordHash ??= rawHash;
        if (!firstMetaHash && value.type === "session_meta") firstMetaHash = rawHash;
        if (!firstBoundaryHash && isLegacyBoundary(value)) firstBoundaryHash = rawHash;
        records.push({ ordinal, value });
      } catch {
        diagnostics.add({ code: "corrupt_line", severity: "warning", message: "A malformed committed rollout line was skipped.", sourceKey: basename(path), ordinal });
      }
    }
    if (partialTail) diagnostics.add({ code: "partial_line", severity: "info", message: "An unterminated final rollout line remains uncommitted.", sourceKey: basename(path), ordinal: baseLine + lines.length + 1 });
    const committedOffset = start + committed.length;
    const head = await readWindow(handle, 0, Math.min(PROBE_BYTES, observedEof));
    const tailOffset = Math.max(0, observedEof - PROBE_BYTES);
    const tail = await readWindow(handle, tailOffset, observedEof - tailOffset);
    const identityPrefixHash = checkpoint?.identityPrefixHash ?? digest([firstMetaHash ?? firstCommittedRecordHash ?? "empty", firstBoundaryHash ?? "empty"]);
    return {
      records,
      mode: append ? "append" : "full",
      partialTail,
      identityPrefixHash,
      checkpoint: {
        decoderVersion: DECODER_VERSION,
        observedEof,
        committedOffset,
        physicalLineCount: baseLine + lines.length,
        headHash: hash(head),
        tailOffset,
        tailHash: hash(tail),
        identityPrefixHash,
      },
      bytesRead: length + head.length + tail.length,
    };
  } finally {
    await handle.close();
  }
}

async function checkpointMatches(handle: Awaited<ReturnType<typeof open>>, checkpoint: RolloutCheckpoint): Promise<boolean> {
  const head = await readWindow(handle, 0, Math.min(PROBE_BYTES, checkpoint.observedEof));
  const tail = await readWindow(handle, checkpoint.tailOffset, checkpoint.observedEof - checkpoint.tailOffset);
  return hash(head) === checkpoint.headHash && hash(tail) === checkpoint.tailHash;
}

async function readWindow(handle: Awaited<ReturnType<typeof open>>, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, length));
  if (!length) return buffer;
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

async function walkJsonl(root: string): Promise<string[]> {
  const output: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walkJsonl(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(path);
  }
  return output;
}

function projectSegments(sessionId: string, segments: readonly Segment[]): CodexThreadRecord {
  const metadata = segments.flatMap((segment) => segment.records.filter((record) => record.value.type === "session_meta").map((record) => record.value.payload).filter(isRecord));
  const cwds = unique(metadata.map((value) => stringValue(value.cwd)).filter((value): value is string => Boolean(value)));
  const firstUser = segments.flatMap((segment) => segment.records).map((record) => userText(record.value)).find(Boolean);
  const timestamps = segments.flatMap((segment) => segment.records).map((record) => eventTimestamp(record.value)).filter((value): value is number => value !== undefined);
  const firstMeta = metadata[0] ?? {};
  const parent = findNestedString(firstMeta, new Set(["parent_thread_id", "parent_session_id", "forked_from", "forkedFromId"]));
  const originTurn = findNestedString(firstMeta, new Set(["origin_turn_id", "originTurnId", "last_turn_id", "lastTurnId"]));
  const source = sourceText(firstMeta.source ?? firstMeta.originator);
  return {
    id: sessionId,
    title: compactText(firstUser),
    preview: compactText(firstUser),
    cwd: cwds[0],
    observedCwds: cwds,
    projectId: stringValue(firstMeta.project_id),
    createdAtMs: timestamps.length ? Math.min(...timestamps) : undefined,
    updatedAtMs: timestamps.length ? Math.max(...timestamps) : undefined,
    archived: segments.every((segment) => segment.archived),
    source,
    historyMode: stringValue(firstMeta.history_mode),
    rolloutPaths: segments.map((segment) => segment.path),
    physicalSegmentCount: segments.length,
    sourceTier: "reconciliation",
    partial: segments.some((segment) => segment.partial),
    nativeLineage: parent ? {
      providerId: "codex",
      sessionId,
      parentSessionId: parent,
      ...(originTurn ? { originTurnId: originTurn } : {}),
      kind: /subagent/i.test(source ?? "") ? "subagent_spawn" : /history/i.test(source ?? "") ? "history_base" : originTurn ? "user_fork" : "unknown_native",
      recovery: originTurn ? "exact" : "session_only",
    } : undefined,
  };
}

interface MutableTurn {
  sessionId: string;
  turnId: string;
  ordinal: number;
  status: CodexTurnRecord["status"];
  initiator: CodexTurnRecord["initiator"];
  inputText?: string;
  assistantFinal?: string;
  attachments: { kind: "image" | "file" | "audio" | "unknown"; name?: string; mimeType?: string }[];
  tools: CodexToolRecord[];
  startedAtMs?: number;
  completedAtMs?: number;
  partial: boolean;
  issues: string[];
}

function projectRolloutTurns(sessionId: string, segments: readonly Segment[], diagnostics: DiagnosticCollector, aliases?: TurnIdentityAlias[]): CodexTurnRecord[] {
  const turns = new Map<string, MutableTurn>();
  let currentId: string | undefined;
  let currentIsNative = false;
  let nextOrdinal = 1;
  const toolOwners = new Map<string, MutableTurn>();
  for (const segment of segments) {
    for (const record of segment.records) {
      const outerType = stringValue(record.value.type) ?? "";
      const payload = isRecord(record.value.payload) ? record.value.payload : record.value;
      const eventType = stringValue(payload.type) ?? outerType;
      const time = eventTimestamp(record.value);
      if (outerType === "session_meta" || outerType === "turn_context") continue;
      if (outerType === "event_msg") {
        if (eventType === "task_started") {
          currentId = stringValue(payload.turn_id) ?? recoveredTurnId(sessionId, segment.segmentIdentity, record.ordinal);
          currentIsNative = Boolean(stringValue(payload.turn_id));
          ensureTurn(currentId, time, false);
        } else if (eventType === "task_complete") {
          const turn = ensureTurn(stringValue(payload.turn_id) ?? currentId ?? recoveredTurnId(sessionId, segment.segmentIdentity, record.ordinal), time, true);
          turn.status = /fail|error/i.test(String(payload.status ?? "")) ? "failed" : "completed";
          turn.completedAtMs = time;
          turn.assistantFinal = stringValue(payload.last_agent_message) ?? turn.assistantFinal;
          currentId = undefined;
          currentIsNative = false;
        } else if (eventType === "turn_aborted" || eventType === "task_aborted") {
          const turn = ensureTurn(stringValue(payload.turn_id) ?? currentId ?? recoveredTurnId(sessionId, segment.segmentIdentity, record.ordinal), time, true);
          turn.status = "interrupted";
          turn.completedAtMs = time;
          currentId = undefined;
          currentIsNative = false;
        } else if (eventType === "user_message") {
          const current = currentId ? turns.get(currentId) : undefined;
          const turn = currentId && (currentIsNative || !current?.inputText) ? ensureTurn(currentId, time, false) : startLegacy(segment, record, time);
          turn.inputText = stringValue(payload.message ?? payload.text) ?? turn.inputText;
          turn.initiator = "user";
        } else if (eventType === "agent_message") {
          const turn = ensureTurn(currentId ?? recoveredTurnId(sessionId, segment.segmentIdentity, record.ordinal), time, true);
          turn.assistantFinal = stringValue(payload.message ?? payload.text) ?? turn.assistantFinal;
        } else if (/error|failed/.test(eventType)) {
          const turn = ensureTurn(currentId ?? recoveredTurnId(sessionId, segment.segmentIdentity, record.ordinal), time, true);
          turn.status = "failed";
          turn.completedAtMs = time;
        } else if (!KNOWN_EVENT_MESSAGES.has(eventType)) {
          diagnostics.add({ code: "unknown_event", severity: "info", message: `Unknown event_msg payload type: ${eventType || "<missing>"}.`, sessionId, sourceKey: basename(segment.path), ordinal: record.ordinal });
        }
      } else if (outerType === "response_item") {
        const isUserMessage = payload.type === "message" && payload.role === "user";
        const current = currentId ? turns.get(currentId) : undefined;
        const turn = isUserMessage && (!currentId || (!currentIsNative && Boolean(current?.inputText)))
          ? startLegacy(segment, record, time)
          : ensureTurn(currentId ?? recoveredTurnId(sessionId, segment.segmentIdentity, record.ordinal), time, true);
        projectResponseItem(payload, turn, toolOwners);
      } else if (!KNOWN_OUTER_TYPES.has(outerType)) {
        diagnostics.add({ code: "unknown_event", severity: "info", message: `Unknown rollout event type: ${outerType || "<missing>"}.`, sessionId, sourceKey: basename(segment.path), ordinal: record.ordinal });
      }
    }
  }

  function ensureTurn(id: string, startedAt: number | undefined, recovered: boolean): MutableTurn {
    const found = turns.get(id);
    if (found) return found;
    const turn: MutableTurn = {
      sessionId,
      turnId: id,
      ordinal: nextOrdinal++,
      status: "in_progress",
      initiator: "unknown",
      attachments: [],
      tools: [],
      startedAtMs: startedAt,
      partial: recovered,
      issues: recovered ? ["turn_boundary_recovered_without_native_start"] : [],
    };
    turns.set(id, turn);
    return turn;
  }

  function startLegacy(segment: Segment, record: DecodedRecord, time: number | undefined): MutableTurn {
    if (currentId) {
      const previous = turns.get(currentId);
      if (previous?.status === "in_progress") previous.status = "partial";
    }
    currentId = recoveredTurnId(sessionId, segment.segmentIdentity, record.ordinal);
    currentIsNative = false;
    const turn = ensureTurn(currentId, time, true);
    aliases?.push({ providerId: "codex", sessionId, oldNativeTurnId: legacyRecoveredTurnId(segment.path, record.ordinal), newNativeTurnId: currentId, displayOrdinal: turn.ordinal, boundaryRecordOrdinal: record.ordinal });
    return turn;
  }

  return [...turns.values()].sort((a, b) => a.ordinal - b.ordinal).map((turn) => ({
    ...turn,
    status: turn.status === "in_progress" && turn.partial ? "partial" : turn.status,
    sourceTier: "reconciliation" as const,
  }));
}

function projectResponseItem(payload: Record<string, unknown>, turn: MutableTurn, toolOwners: Map<string, MutableTurn>): void {
  const type = stringValue(payload.type) ?? "";
  if (type === "message") {
    const text = messageContent(payload.content);
    if (payload.role === "user") {
      turn.inputText = text ?? turn.inputText;
      turn.initiator = "user";
      turn.attachments.push(...messageAttachments(payload.content));
    } else if (payload.role === "assistant") turn.assistantFinal = text ?? turn.assistantFinal;
    return;
  }
  if (["function_call", "custom_tool_call", "local_shell_call", "computer_call"].includes(type)) {
    const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
    const tool: CodexToolRecord = {
      callId,
      name: stringValue(payload.name) ?? type,
      status: "requested",
      inputSummary: summarize(payload.arguments ?? payload.input ?? payload.action),
    };
    turn.tools.push(tool);
    if (callId) toolOwners.set(callId, turn);
    return;
  }
  if (["function_call_output", "custom_tool_call_output", "local_shell_call_output", "computer_call_output"].includes(type)) {
    const callId = stringValue(payload.call_id);
    const owner = callId ? toolOwners.get(callId) ?? turn : turn;
    const index = owner.tools.findIndex((tool) => tool.callId === callId);
    const outputSummary = summarize(payload.output ?? payload.result);
    if (index >= 0) owner.tools[index] = { ...owner.tools[index]!, status: "completed", outputSummary };
    else owner.tools.push({ callId, name: "unknown_tool", status: "completed", outputSummary });
  }
}

function messageContent(content: unknown): string | undefined {
  if (typeof content === "string") return stringValue(content);
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) if (isRecord(part)) {
    const text = stringValue(part.text ?? part.input_text ?? part.output_text);
    if (text) parts.push(text);
  }
  return parts.length ? parts.join("\n") : undefined;
}

function messageAttachments(content: unknown): MutableTurn["attachments"] {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap((part) => {
    const type = stringValue(part.type) ?? "";
    if (!/image|file|audio/i.test(type)) return [];
    const kind = /image/i.test(type) ? "image" : /audio/i.test(type) ? "audio" : "file";
    return [{ kind: kind as "image" | "file" | "audio", name: stringValue(part.name), mimeType: stringValue(part.mime_type) }];
  });
}

function userText(value: Record<string, unknown>): string | undefined {
  const payload = isRecord(value.payload) ? value.payload : value;
  if (value.type === "event_msg" && payload.type === "user_message") return compactText(payload.message ?? payload.text);
  if (value.type === "response_item" && payload.type === "message" && payload.role === "user") return messageContent(payload.content);
  return undefined;
}

function sourceText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return stringValue(value.type) ?? stringValue(value.kind) ?? summarize(value);
}

function findNestedString(value: unknown, keys: ReadonlySet<string>, depth = 0): string | undefined {
  if (!isRecord(value) || depth > 5) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === "string" && child.length) return child;
  }
  for (const child of Object.values(value)) {
    const found = findNestedString(child, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function eventTimestamp(value: Record<string, unknown>): number | undefined {
  const raw = value.timestamp ?? value.created_at ?? value.createdAt;
  if (typeof raw === "number") return raw < 10_000_000_000 ? raw * 1_000 : raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function summarize(value: unknown): string | undefined {
  if (typeof value === "string") return compactText(value);
  try {
    return compactText(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function compareSegments(a: Segment, b: Segment): number {
  const aTime = a.records.map((record) => eventTimestamp(record.value)).find((value) => value !== undefined) ?? 0;
  const bTime = b.records.map((record) => eventTimestamp(record.value)).find((value) => value !== undefined) ?? 0;
  return aTime - bTime || a.path.localeCompare(b.path);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function hash(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isLegacyBoundary(value: Record<string, unknown>): boolean {
  const payload = isRecord(value.payload) ? value.payload : value;
  return value.type === "event_msg" && payload.type === "user_message"
    || value.type === "response_item" && payload.type === "message" && payload.role === "user";
}

const KNOWN_EVENT_MESSAGES = new Set([
  "task_started", "task_complete", "turn_aborted", "task_aborted", "user_message", "agent_message",
  "agent_reasoning", "token_count", "context_compacted", "entered_review_mode", "exited_review_mode",
  "plan_update", "mcp_startup_update", "mcp_startup_complete", "stream_error", "warning", "notice",
  "thread_settings_applied", "patch_apply_end", "web_search_end", "thread_rolled_back", "mcp_tool_call_end",
  "item_completed", "sub_agent_activity", "thread_goal_updated",
]);

const KNOWN_OUTER_TYPES = new Set([
  "session_meta", "turn_context", "event_msg", "response_item", "compacted", "ghost_snapshot",
  "world_state", "inter_agent_communication_metadata",
]);
