import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { basename, join } from "node:path";
import type { DiagnosticCollector } from "./diagnostics.ts";
import type { CodexThreadRecord, CodexToolRecord, CodexTurnRecord, SourceSnapshot } from "./internal.ts";
import { compactText, isRecord, stringValue } from "./internal.ts";
import { digest, legacyRecoveredTurnId, recoveredTurnId, stableRolloutFileIdentity, stableSegmentIdentity, type TurnIdentityAlias } from "./turn-identity.ts";
import { RolloutSourceRegistry, type RolloutRegistryFileInput, type RolloutRegistryFileState, type RolloutRegistrySessionSummary } from "./rollout-registry.ts";

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
  /** Narrow deterministic test seam; production uses decodeRollout. */
  readonly decodeRollout?: (path: string, checkpoint: RolloutCheckpoint | undefined, diagnostics: DiagnosticCollector) => Promise<DecodedRollout>;
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

interface SessionSummary {
  readonly id: string;
  readonly title?: string;
  readonly preview?: string;
  readonly cwds: readonly string[];
  readonly projectId?: string;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
  readonly archived: boolean;
  readonly source?: string;
  readonly historyMode?: string;
  readonly parentSessionId?: string;
  readonly originTurnId?: string;
  readonly turnCount: number;
  readonly turnIds: readonly string[];
  readonly legacyBoundaryOrdinals: readonly number[];
}

interface SummaryAccumulator {
  readonly archived: boolean;
  readonly sessions: Map<string, {
    id: string;
    title?: string;
    preview?: string;
    cwds: Set<string>;
    projectId?: string;
    createdAtMs?: number;
    updatedAtMs?: number;
    archived: boolean;
    source?: string;
    historyMode?: string;
    parentSessionId?: string;
    originTurnId?: string;
    turnKeys: Set<string>;
    legacyBoundaries: Set<number>;
    currentId?: string;
    currentIsNative: boolean;
    currentHasInput: boolean;
  }>;
  currentSessionId?: string;
  firstCommittedRecordHash?: string;
  firstMetaHash?: string;
  firstBoundaryHash?: string;
}

interface SegmentDescriptor {
  readonly path: string;
  readonly archived: boolean;
  readonly partial: boolean;
  readonly sessionId: string;
  readonly segmentIdentity: string;
  readonly registryFileId: string;
  readonly checkpoint: RolloutCheckpoint;
  readonly contentStamp: string;
  readonly summary: SessionSummary;
}

interface FileState {
  readonly path: string;
  readonly archived: boolean;
  readonly checkpoint: RolloutCheckpoint;
  readonly sessionIds: ReadonlySet<string>;
  readonly registryFileId: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sourceStamp: string;
  readonly contentStamp: string;
  readonly summaries: readonly SessionSummary[];
}

export class RolloutCodexSource {
  readonly #options: RolloutSourceOptions;
  readonly #descriptors = new Map<string, SegmentDescriptor[]>();
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

  /** Reconciles rollout metadata without retaining decoded rollout records. */
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
    const persisted = initial ? new Map((this.#registry?.snapshot() ?? []).map((file) => [pathKey(file.canonicalPath), file])) : new Map<string, RolloutRegistryFileState>();
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
      if (previous && changedPaths === undefined && observed.size === previous.size && observed.mtimeMs === previous.mtimeMs && await probeUnchanged(entry.path, previous.checkpoint)) continue;
      try {
        const cached = !previous && persisted.get(key);
        if (cached && cached.size === observed.size && cached.mtimeMs === observed.mtimeMs && cached.checkpoint.decoderVersion === DECODER_VERSION && cached.contentStamp && cached.sessions.length > 0 && cached.sessions.every((session) => Boolean(session.summary)) && await probeUnchanged(entry.path, cached.checkpoint)) {
          const summaries = cached.sessions.map((session) => registrySummary(session.summary!, session.sessionId, entry.archived));
          files.set(key, { path: entry.path, archived: entry.archived, checkpoint: cached.checkpoint, sessionIds: new Set(summaries.map((summary) => summary.id)), registryFileId: cached.registryFileId, size: observed.size, mtimeMs: observed.mtimeMs, sourceStamp: cached.sourceStamp, contentStamp: cached.contentStamp, summaries });
          continue;
        }
        const decoder = this.#options.decodeRollout ?? decodeRollout;
        const appendCandidate = previous && await canAppend(entry.path, previous.checkpoint);
        const decoded = appendCandidate ? await decoder(entry.path, previous?.checkpoint, this.#options.diagnostics) : undefined;
        const scanned = decoded?.mode === "append" && previous
          ? appendMetadata(previous, decoded, entry.archived)
          : decoded
            ? metadataFromRecords(decoded.records, decoded.checkpoint, decoded.identityPrefixHash, decoded.partialTail, entry.archived, decoded.bytesRead)
            : await scanRolloutMetadata(entry.path, entry.archived, this.#options.diagnostics);
        bytesRead += scanned.bytesRead;
        if (decoded?.mode === "append" && previous) filesDecodedAppend += 1;
        else filesDecodedFull += 1;
        const ids = scanned.summaries.map((summary) => summary.id);
        if (!ids.length) {
          this.#options.diagnostics.add({ code: "orphan_rollout", severity: "warning", message: "A rollout has no usable session metadata id.", sourceKey: basename(entry.path) });
          files.delete(key);
          affectedPaths.add(entry.path);
          if (previous) for (const sessionId of previous.sessionIds) affectedSessions.add(sessionId);
          continue;
        }
        if (ids.length > 1) this.#options.diagnostics.add({ code: "duplicate_metadata_id", severity: "warning", message: "A rollout contains repeated or conflicting session metadata.", sourceKey: basename(entry.path) });
        const registryFileId = stableRolloutFileIdentity(ids, scanned.identityPrefixHash);
        const sourceStamp = digest(["rollout-source-v1", String(scanned.checkpoint.observedEof), scanned.checkpoint.headHash, scanned.checkpoint.tailHash, scanned.checkpoint.identityPrefixHash ?? ""]);
        const contentStamp = scanned.contentStamp;
        const contentChanged = !previous || previous.contentStamp !== contentStamp || previous.archived !== entry.archived;
        files.set(key, { path: entry.path, archived: entry.archived, checkpoint: scanned.checkpoint, sessionIds: new Set(ids), registryFileId, size: observed.size, mtimeMs: observed.mtimeMs, sourceStamp, contentStamp, summaries: scanned.summaries });
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
    const descriptors = buildDescriptors(files);
    const threads: CodexThreadRecord[] = [];
    for (const [sessionId, sessionDescriptors] of descriptors) {
      const ordered = sessionDescriptors.slice().sort(compareDescriptors);
      if (ordered.length > 1) this.#options.diagnostics.add({ code: "multi_segment_session", severity: "info", message: `One logical session aggregates ${ordered.length} rollout segments.`, sessionId });
      threads.push(projectSummary(sessionId, ordered));
    }
    const snapshot: SourceSnapshot = { threads, projects: [] };
    const previousIds = new Set(this.#snapshot?.threads.map((thread) => thread.id) ?? []);
    const nextIds = new Set(threads.map((thread) => thread.id));
    const deletedSessionIds = [...previousIds].filter((id) => !nextIds.has(id));
    const changed = initial || deletedSessionIds.length > 0 || affectedPaths.size > 0;
    if (changed) await this.#registry?.reconcile(await registryInputs(files, descriptors));
    this.#files = files;
    this.#descriptors.clear();
    for (const [sessionId, sessionDescriptors] of descriptors) this.#descriptors.set(sessionId, sessionDescriptors);
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
    const segments = await this.#readSegments(sessionId, knownPaths);
    if (!segments.length) return [];
    return projectRolloutTurns(sessionId, segments.slice().sort(compareSegments), this.#options.diagnostics);
  }

  async #readSegments(sessionId: string, knownPaths: readonly string[] = []): Promise<Segment[]> {
    const descriptors = this.#descriptors.get(sessionId) ?? (knownPaths.length ? knownPaths.map((path) => ({ path, archived: path.toLocaleLowerCase("en-US").includes("archived_sessions"), partial: false, sessionId, segmentIdentity: stableSegmentIdentity(sessionId, "unknown"), registryFileId: stableRolloutFileIdentity([sessionId], "unknown"), checkpoint: emptyCheckpoint(), summary: { id: sessionId, cwds: [], archived: false, turnCount: 0, turnIds: [], legacyBoundaryOrdinals: [] } })) : []);
    const segments: Segment[] = [];
    for (const descriptor of descriptors) {
      try {
        const observed = await stat(descriptor.path).catch(() => undefined);
        const readLimit = observed && observed.size > descriptor.checkpoint.observedEof ? descriptor.checkpoint.observedEof : undefined;
        const decoded = await decodeRollout(descriptor.path, undefined, this.#options.diagnostics, readLimit);
        segments.push({ path: descriptor.path, archived: descriptor.archived, records: decoded.records, partial: decoded.partialTail, sessionId, segmentIdentity: descriptor.segmentIdentity, registryFileId: descriptor.registryFileId });
      } catch {
        this.#options.diagnostics.add({ code: "corrupt_line", severity: "error", message: "A registered rollout could not be decoded.", sessionId, sourceKey: basename(descriptor.path) });
      }
    }
    return segments;
  }

  segmentCount(sessionId: string): number {
    return this.#descriptors.get(sessionId)?.length ?? 0;
  }

  countTurns(sessionId: string): number {
    const descriptors = this.#descriptors.get(sessionId) ?? [];
    const ids = new Set<string>();
    for (const descriptor of descriptors) for (const id of descriptor.summary.turnIds) ids.add(id);
    return ids.size || descriptors.reduce((count, descriptor) => count + descriptor.summary.turnCount, 0);
  }

  /** Cheap rebuildable freshness stamp derived from registered segment metadata. */
  sessionSourceStamp(sessionId: string): string | undefined {
    const descriptors = this.#descriptors.get(sessionId);
    if (!descriptors?.length) return undefined;
    return digest([
      "session-source-v1",
        ...descriptors.slice().sort(compareDescriptors).map((descriptor) => [
        descriptor.segmentIdentity,
        descriptor.registryFileId,
        descriptor.contentStamp,
        descriptor.checkpoint.observedEof,
        descriptor.checkpoint.committedOffset,
        descriptor.checkpoint.headHash,
        descriptor.checkpoint.tailHash,
        descriptor.summary.turnCount,
        descriptor.summary.turnIds.join(","),
      ].join("\0")),
    ]);
  }

  async listTurnIdentityAliases(): Promise<readonly TurnIdentityAlias[]> {
    const aliases: TurnIdentityAlias[] = [];
    // Rebuild aliases from metadata. This keeps startup migration lazy; full turn
    // decoding remains reserved for an explicit legacy lookup.
    for (const [sessionId, descriptors] of this.#descriptors) {
      let offset = 0;
      for (const descriptor of descriptors.slice().sort(compareDescriptors)) {
        for (const ordinal of descriptor.summary.legacyBoundaryOrdinals) {
          const key = `legacy:${ordinal}`;
          const displayOrdinal = offset + Math.max(1, descriptor.summary.turnIds.indexOf(key) + 1);
          aliases.push({ providerId: "codex", sessionId, oldNativeTurnId: legacyRecoveredTurnId(descriptor.path, ordinal), newNativeTurnId: recoveredTurnId(sessionId, descriptor.segmentIdentity, ordinal), displayOrdinal, boundaryRecordOrdinal: ordinal });
        }
        offset += descriptor.summary.turnCount;
      }
    }
    return aliases;
  }
}

interface MetadataScan {
  readonly summaries: readonly SessionSummary[];
  readonly checkpoint: RolloutCheckpoint;
  readonly identityPrefixHash: string;
  readonly contentStamp: string;
  readonly partialTail: boolean;
  readonly bytesRead: number;
}

function emptyCheckpoint(): RolloutCheckpoint {
  return { decoderVersion: DECODER_VERSION, observedEof: 0, committedOffset: 0, physicalLineCount: 0, headHash: hash(Buffer.alloc(0)), tailOffset: 0, tailHash: hash(Buffer.alloc(0)) };
}

function metadataFromRecords(records: readonly DecodedRecord[], checkpoint: RolloutCheckpoint, identityPrefixHash: string, partialTail: boolean, archived: boolean, bytesRead: number): MetadataScan {
  const accumulator = createSummaryAccumulator(archived);
  for (const record of records) consumeSummaryRecord(accumulator, record);
  const summaries = finalizeSummaries(accumulator);
  return { summaries, checkpoint, identityPrefixHash, partialTail, bytesRead, contentStamp: digest(["rollout-content-v1", ...records.map((record) => `${record.ordinal}:${JSON.stringify(record.value)}`)]) };
}

function appendMetadata(previous: FileState, decoded: DecodedRollout, archived: boolean): MetadataScan {
  const accumulator = createSummaryAccumulator(archived);
  for (const summary of previous.summaries) accumulator.sessions.set(summary.id, {
    id: summary.id,
    title: summary.title,
    preview: summary.preview,
    cwds: new Set(summary.cwds),
    projectId: summary.projectId,
    createdAtMs: summary.createdAtMs,
    updatedAtMs: summary.updatedAtMs,
    archived: summary.archived,
    source: summary.source,
    historyMode: summary.historyMode,
    parentSessionId: summary.parentSessionId,
    originTurnId: summary.originTurnId,
    turnKeys: new Set(summary.turnIds),
    legacyBoundaries: new Set(summary.legacyBoundaryOrdinals),
    currentIsNative: false,
    currentHasInput: false,
  });
  accumulator.currentSessionId = previous.summaries[0]?.id;
  for (const record of decoded.records) consumeSummaryRecord(accumulator, record);
  const identityPrefixHash = decoded.identityPrefixHash || previous.checkpoint.identityPrefixHash || "";
  return { summaries: finalizeSummaries(accumulator), checkpoint: decoded.checkpoint, identityPrefixHash, partialTail: decoded.partialTail, bytesRead: decoded.bytesRead, contentStamp: digest([previous.contentStamp, ...decoded.records.map((record) => `${record.ordinal}:${JSON.stringify(record.value)}`), decoded.partialTail ? "partial" : "committed"]) };
}

function createSummaryAccumulator(archived: boolean): SummaryAccumulator {
  return { archived, sessions: new Map(), currentSessionId: undefined, firstCommittedRecordHash: undefined, firstMetaHash: undefined, firstBoundaryHash: undefined };
}

function consumeSummaryRecord(accumulator: SummaryAccumulator, record: DecodedRecord): void {
  const value = record.value;
  const payload = isRecord(value.payload) ? value.payload : value;
  if (value.type === "session_meta" && isRecord(value.payload)) {
    const meta = value.payload;
    const id = stringValue(meta.id);
    if (!id) return;
    accumulator.currentSessionId = id;
    const existing = accumulator.sessions.get(id);
    const state = existing ?? { id, cwds: new Set<string>(), archived: accumulator.archived, turnKeys: new Set<string>(), legacyBoundaries: new Set<number>(), currentIsNative: false, currentHasInput: false };
    state.archived = state.archived || accumulator.archived;
    const cwd = stringValue(meta.cwd); if (cwd) state.cwds.add(cwd);
    state.projectId ??= stringValue(meta.project_id);
    state.source ??= sourceText(meta.source ?? meta.originator);
    state.historyMode ??= stringValue(meta.history_mode);
    state.parentSessionId ??= findNestedString(meta, new Set(["parent_thread_id", "parent_session_id", "forked_from", "forkedFromId"]));
    state.originTurnId ??= findNestedString(meta, new Set(["origin_turn_id", "originTurnId", "last_turn_id", "lastTurnId"]));
    const time = eventTimestamp(value); if (time !== undefined) { state.createdAtMs = state.createdAtMs === undefined ? time : Math.min(state.createdAtMs, time); state.updatedAtMs = state.updatedAtMs === undefined ? time : Math.max(state.updatedAtMs, time); }
    accumulator.sessions.set(id, state);
    return;
  }
  const sessionId = accumulator.currentSessionId;
  if (!sessionId) return;
  const state = accumulator.sessions.get(sessionId);
  if (!state) return;
  const time = eventTimestamp(value); if (time !== undefined) { state.createdAtMs = state.createdAtMs === undefined ? time : Math.min(state.createdAtMs, time); state.updatedAtMs = state.updatedAtMs === undefined ? time : Math.max(state.updatedAtMs, time); }
  const outerType = stringValue(value.type) ?? "";
  const eventType = stringValue(payload.type) ?? outerType;
  if (outerType === "event_msg") {
    if (eventType === "task_started") {
      const id = stringValue(payload.turn_id) ?? `legacy:${record.ordinal}`;
      state.turnKeys.add(id); state.currentId = id; state.currentIsNative = Boolean(stringValue(payload.turn_id)); state.currentHasInput = false;
    } else if (eventType === "task_complete" || eventType === "turn_aborted" || eventType === "task_aborted") {
      const id = stringValue(payload.turn_id) ?? state.currentId ?? `legacy:${record.ordinal}`;
      state.turnKeys.add(id); state.currentId = undefined; state.currentIsNative = false; state.currentHasInput = false;
    } else if (eventType === "user_message") {
      if (!state.currentId) { state.currentId = `legacy:${record.ordinal}`; state.turnKeys.add(state.currentId); state.legacyBoundaries.add(record.ordinal); }
      state.currentHasInput = true; state.title ??= userText(value); state.preview ??= userText(value);
    }
  } else if (outerType === "response_item") {
    const isUser = payload.type === "message" && payload.role === "user";
    if (isUser && (!state.currentId || (!state.currentIsNative && state.currentHasInput))) { state.currentId = `legacy:${record.ordinal}`; state.turnKeys.add(state.currentId); state.legacyBoundaries.add(record.ordinal); state.currentIsNative = false; state.currentHasInput = true; }
    if (isUser) { state.title ??= userText(value); state.preview ??= userText(value); }
  }
}

function finalizeSummaries(accumulator: SummaryAccumulator): SessionSummary[] {
  return [...accumulator.sessions.values()].map((state) => ({ id: state.id, ...(state.title ? { title: compactText(state.title) } : {}), ...(state.preview ? { preview: compactText(state.preview) } : {}), cwds: [...state.cwds], ...(state.projectId ? { projectId: state.projectId } : {}), ...(state.createdAtMs !== undefined ? { createdAtMs: state.createdAtMs } : {}), ...(state.updatedAtMs !== undefined ? { updatedAtMs: state.updatedAtMs } : {}), archived: state.archived, ...(state.source ? { source: state.source } : {}), ...(state.historyMode ? { historyMode: state.historyMode } : {}), ...(state.parentSessionId ? { parentSessionId: state.parentSessionId } : {}), ...(state.originTurnId ? { originTurnId: state.originTurnId } : {}), turnCount: state.turnKeys.size, turnIds: [...state.turnKeys], legacyBoundaryOrdinals: [...state.legacyBoundaries] }));
}

function registrySummary(summary: RolloutRegistrySessionSummary, id: string, archived: boolean): SessionSummary {
  return { id, ...(summary.title ? { title: summary.title } : {}), ...(summary.preview ? { preview: summary.preview } : {}), cwds: summary.cwds, ...(summary.projectId ? { projectId: summary.projectId } : {}), ...(summary.createdAtMs !== undefined ? { createdAtMs: summary.createdAtMs } : {}), ...(summary.updatedAtMs !== undefined ? { updatedAtMs: summary.updatedAtMs } : {}), archived: summary.archived || archived, ...(summary.source ? { source: summary.source } : {}), ...(summary.historyMode ? { historyMode: summary.historyMode } : {}), ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}), ...(summary.originTurnId ? { originTurnId: summary.originTurnId } : {}), turnCount: summary.turnCount, turnIds: summary.turnIds, legacyBoundaryOrdinals: summary.legacyBoundaryOrdinals };
}

async function scanRolloutMetadata(path: string, archived: boolean, diagnostics: DiagnosticCollector): Promise<MetadataScan> {
  const handle = await open(path, "r");
  try {
    const observedEof = (await handle.stat()).size;
    const decoder = new StringDecoder("utf8");
    const accumulator = createSummaryAccumulator(archived);
    const content = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let pending = "";
    let bytesRead = 0;
    let committedOffset = 0;
    let physicalLineCount = 0;
    let firstMetaHash: string | undefined;
    let firstBoundaryHash: string | undefined;
    let firstCommittedRecordHash: string | undefined;
    const consumeLine = (rawLine: string): void => {
      const raw = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      physicalLineCount += 1;
      if (!raw) return;
      if (Buffer.byteLength(raw) > MAX_LINE_BYTES) { diagnostics.add({ code: "corrupt_line", severity: "warning", message: "A committed rollout line exceeded the decoder limit.", sourceKey: basename(path), ordinal: physicalLineCount }); return; }
      try {
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value)) throw new Error("record is not an object");
        const rawHash = digest([raw]);
        firstCommittedRecordHash ??= rawHash;
        if (!firstMetaHash && value.type === "session_meta") firstMetaHash = rawHash;
        if (!firstBoundaryHash && isLegacyBoundary(value)) firstBoundaryHash = rawHash;
        consumeSummaryRecord(accumulator, { ordinal: physicalLineCount, value });
      } catch { diagnostics.add({ code: "corrupt_line", severity: "warning", message: "A malformed committed rollout line was skipped.", sourceKey: basename(path), ordinal: physicalLineCount }); }
    };
    let position = 0;
    while (position < observedEof) {
      const { bytesRead: read } = await handle.read(chunk, 0, chunk.length, position);
      if (!read) break;
      const bytes = chunk.subarray(0, read);
      content.update(bytes); bytesRead += read; position += read;
      pending += decoder.write(bytes);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        committedOffset += Buffer.byteLength(line) + 1;
        consumeLine(line);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    const partialTail = pending.length > 0;
    if (partialTail) diagnostics.add({ code: "partial_line", severity: "info", message: "An unterminated final rollout line remains uncommitted.", sourceKey: basename(path), ordinal: physicalLineCount + 1 });
    const head = await readWindow(handle, 0, Math.min(PROBE_BYTES, observedEof));
    const tailOffset = Math.max(0, observedEof - PROBE_BYTES);
    const tail = await readWindow(handle, tailOffset, observedEof - tailOffset);
    const identityPrefixHash = digest([firstMetaHash ?? firstCommittedRecordHash ?? "empty", firstBoundaryHash ?? "empty"]);
    const checkpoint: RolloutCheckpoint = { decoderVersion: DECODER_VERSION, observedEof, committedOffset, physicalLineCount, headHash: hash(head), tailOffset, tailHash: hash(tail), identityPrefixHash };
    return { summaries: finalizeSummaries(accumulator), checkpoint, identityPrefixHash, partialTail, bytesRead: bytesRead + head.length + tail.length, contentStamp: digest(["rollout-content-v1", content.digest("hex")]) };
  } finally { await handle.close(); }
}

function buildDescriptors(files: ReadonlyMap<string, FileState>): Map<string, SegmentDescriptor[]> {
  const descriptors = new Map<string, SegmentDescriptor[]>();
  for (const file of files.values()) for (const summary of file.summaries) {
    const values = descriptors.get(summary.id) ?? [];
      values.push({ path: file.path, archived: file.archived, partial: file.checkpoint.committedOffset !== file.checkpoint.observedEof, sessionId: summary.id, segmentIdentity: stableSegmentIdentity(summary.id, file.checkpoint.identityPrefixHash ?? ""), registryFileId: file.registryFileId, checkpoint: file.checkpoint, contentStamp: file.contentStamp, summary });
    descriptors.set(summary.id, values);
  }
  return descriptors;
}

function compareDescriptors(a: SegmentDescriptor, b: SegmentDescriptor): number {
  return (a.summary.createdAtMs ?? 0) - (b.summary.createdAtMs ?? 0) || a.path.localeCompare(b.path);
}

function projectSummary(sessionId: string, descriptors: readonly SegmentDescriptor[]): CodexThreadRecord {
  const summaries = descriptors.map((descriptor) => descriptor.summary);
  const cwds = unique(summaries.flatMap((summary) => summary.cwds));
  const firstUser = summaries.map((summary) => summary.title ?? summary.preview).find(Boolean);
  const createdAtMs = summaries.map((summary) => summary.createdAtMs).filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
  const updatedAtMs = summaries.map((summary) => summary.updatedAtMs).filter((value): value is number => value !== undefined).sort((a, b) => b - a)[0];
  const parent = summaries.map((summary) => summary.parentSessionId).find(Boolean);
  const originTurn = summaries.map((summary) => summary.originTurnId).find(Boolean);
  const source = summaries.map((summary) => summary.source).find(Boolean);
  return { id: sessionId, title: compactText(firstUser), preview: compactText(firstUser), cwd: cwds[0], observedCwds: cwds, projectId: summaries.map((summary) => summary.projectId).find(Boolean), createdAtMs, updatedAtMs, archived: summaries.every((summary) => summary.archived), source, historyMode: summaries.map((summary) => summary.historyMode).find(Boolean), rolloutPaths: descriptors.map((descriptor) => descriptor.path), physicalSegmentCount: descriptors.length, sourceTier: "reconciliation", partial: descriptors.some((descriptor) => descriptor.partial), nativeLineage: parent ? { providerId: "codex", sessionId, parentSessionId: parent, ...(originTurn ? { originTurnId: originTurn } : {}), kind: /subagent/i.test(source ?? "") ? "subagent_spawn" : /history/i.test(source ?? "") ? "history_base" : originTurn ? "user_fork" : "unknown_native", recovery: originTurn ? "exact" : "session_only" } : undefined };
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

async function canAppend(path: string, checkpoint: RolloutCheckpoint): Promise<boolean> {
  try {
    const handle = await open(path, "r");
    try {
      const size = (await handle.stat()).size;
      return size > checkpoint.observedEof && checkpoint.decoderVersion === DECODER_VERSION && await checkpointMatches(handle, checkpoint);
    } finally { await handle.close(); }
  } catch { return false; }
}

async function registryInputs(
  files: ReadonlyMap<string, FileState>,
  descriptorsBySession: ReadonlyMap<string, readonly SegmentDescriptor[]>,
): Promise<RolloutRegistryFileInput[]> {
  const inputs: RolloutRegistryFileInput[] = [];
  for (const file of files.values()) {
    const segments: RolloutRegistryFileInput["sessions"] = [];
    for (const [sessionId, sessionDescriptors] of descriptorsBySession) {
      const ordered = sessionDescriptors.slice().sort(compareDescriptors);
      ordered.forEach((descriptor, segmentOrder) => {
        if (descriptor.path === file.path) segments.push({ sessionId, stableSegmentIdentity: descriptor.segmentIdentity, segmentOrder, summary: descriptor.summary });
      });
    }
    const fileStat = await stat(file.path).catch(() => undefined);
    const checkpoint = file.checkpoint;
    inputs.push({
      registryFileId: file.registryFileId,
      canonicalPath: file.path,
      rootKind: file.archived ? "archived" : "active",
      stableFileIdentity: file.registryFileId,
      size: checkpoint.observedEof,
      mtimeMs: fileStat?.mtimeMs ?? 0,
      sourceStamp: file.sourceStamp,
      contentStamp: file.contentStamp,
      checkpoint,
      sessions: segments,
    });
  }
  return inputs;
}

export async function decodeRollout(path: string, checkpoint: RolloutCheckpoint | undefined, diagnostics: DiagnosticCollector, readLimit?: number): Promise<DecodedRollout> {
  const handle = await open(path, "r");
  try {
    const physicalEof = (await handle.stat()).size;
    const observedEof = readLimit === undefined ? physicalEof : Math.min(readLimit, physicalEof);
    const append = readLimit === undefined && checkpoint && checkpoint.decoderVersion === DECODER_VERSION && observedEof > checkpoint.observedEof && await checkpointMatches(handle, checkpoint);
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
