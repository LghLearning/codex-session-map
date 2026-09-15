import { Background, Controls, MiniMap, ReactFlow, useNodesState, useReactFlow, type Connection, type NodeMouseHandler, type Viewport } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBootstrap, getForest, getManualParents, getOverride, getSessionDetail, getSessionTitle, getTurnDetail, getTurnDirectory, latestEdit, undoEdit, writeOverride, writePlacement, type Bootstrap, type OrganizationJobView } from "./api.ts";
import { buildMapGraph, flattenSessions } from "./graph.ts";
import { SectionNode, SessionNode, TurnNode } from "./nodes.tsx";
import { connectionToPlacement, type PlacementDraft } from "./placement.ts";
import type { MapForest, PersistedWorkspaceState, Relation, SearchResult, Selection, SessionNodeData, TurnDirectoryItem } from "./types.ts";
import { RequestSequence, readLastWorkspace, readWorkspaceState, resolveRestoredSelection, saveLastWorkspace, saveWorkspaceState, updateMapUrl } from "./workspace-state.ts";
import { SearchPanel } from "./search/SearchPanel.tsx";
import { useWorkspaceSearch } from "./search/useWorkspaceSearch.ts";
import { resolveSearchNavigation } from "./search/navigation.ts";
import { TurnReader } from "./reader/TurnReader.tsx";
import { OrganizationControl } from "./organization/OrganizationControl.tsx";
import { patchSessionTitle } from "./map-updates.ts";

const nodeTypes = { session: SessionNode, turn: TurnNode, section: SectionNode };
const MAX_EXPANDED = 12;

export default function RealWorkspace() {
  const flow = useReactFlow();
  const requestSequence = useRef(new RequestSequence());
  const fitUnseenWorkspace = useRef(false);
  const pendingLocate = useRef<string | undefined>(undefined);
  const expandedRef = useRef<ReadonlySet<string>>(new Set());
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [workspace, setWorkspace] = useState("");
  const [forest, setForest] = useState<MapForest>();
  const [expanded, setExpanded] = useState(new Set<string>());
  const [turns, setTurns] = useState(new Map<string, TurnDirectoryItem[]>());
  const [turnStates, setTurnStates] = useState(new Map<string, "loading" | "error">());
  const [selection, setSelection] = useState<Selection>();
  const [positions, setPositions] = useState<PersistedWorkspaceState["positions"]>({});
  const [viewport, setViewport] = useState<PersistedWorkspaceState["viewport"]>();
  const [showNative, setShowNative] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [detail, setDetail] = useState<any>();
  const [detailError, setDetailError] = useState("");
  const [draft, setDraft] = useState<{ kind: "title" | "label"; value: string }>();
  const [placement, setPlacement] = useState<PlacementDraft>();
  const [notice, setNotice] = useState("Map ready");
  const [lastEdit, setLastEdit] = useState<any>();
  const [forestError, setForestError] = useState("");
  const [loading, setLoading] = useState(true);
  const [organizationProgress, setOrganizationProgress] = useState<OrganizationJobView>();
  const [eventConnectionRevision, setEventConnectionRevision] = useState(0);
  const search = useWorkspaceSearch(workspace, Boolean(bootstrap?.search?.available));

  const reloadForest = useCallback(async (targetWorkspace: string, signal?: AbortSignal) => {
    const token = requestSequence.current.start();
    try {
      const next = await getForest(targetWorkspace, signal);
      if (!requestSequence.current.current(token)) return;
      setForest(next); setForestError("");
    } catch (error) { if (!signal?.aborted && requestSequence.current.current(token)) setForestError((error as Error).message); }
  }, []);
  const reloadTurnDirectory = useCallback(async (sessionId: string, signal?: AbortSignal) => {
    setTurnStates((current) => new Map(current).set(sessionId, "loading"));
    try {
      const directory = await getTurnDirectory(sessionId, signal);
      setTurns((current) => new Map(current).set(sessionId, directory));
      setTurnStates((current) => { const next = new Map(current); next.delete(sessionId); return next; });
    } catch (error) {
      if (!signal?.aborted) setTurnStates((current) => new Map(current).set(sessionId, "error"));
      throw error;
    }
  }, []);
  const reloadSessionTitle = useCallback(async (sessionId: string) => {
    const semanticTitle = await getSessionTitle(sessionId);
    setForest((current) => patchSessionTitle(current, sessionId, semanticTitle?.displayTitle));
    if (selection?.sessionId === sessionId) setDetail((current: any) => current ? { ...current, semanticTitle } : current);
  }, [selection?.sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const boot = await getBootstrap(controller.signal); setBootstrap(boot);
        const url = new URL(location.href);
        const requested = url.searchParams.get("workspace");
        const preferred = readLastWorkspace(localStorage);
        const selectedWorkspace = boot.scopes.some((scope) => scope.id === requested) ? requested! : boot.scopes.some((scope) => scope.id === preferred) ? preferred! : boot.scopes[0]?.id ?? "";
        if (!selectedWorkspace) throw new Error("No Codex Workspace is available.");
        const saved = readWorkspaceState(localStorage, selectedWorkspace);
        fitUnseenWorkspace.current = !saved.viewport;
        setWorkspace(selectedWorkspace); setExpanded(new Set(saved.expandedSessionIds)); setPositions(saved.positions);
        setViewport(saved.viewport); setShowNative(Boolean(saved.showNative)); setRailCollapsed(Boolean(saved.railCollapsed));
        const restored = resolveRestoredSelection(url, saved.selection); setSelection(restored);
        if (restored?.kind === "turn") setExpanded((current) => limitedExpansion(current, restored.sessionId));
        const next = await getForest(selectedWorkspace, controller.signal); setForest(next);
      } catch (error) { if (!controller.signal.aborted) setForestError((error as Error).message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!workspace) return;
    const saved = readWorkspaceState(localStorage, workspace);
    saveLastWorkspace(localStorage, workspace);
    saveWorkspaceState(localStorage, workspace, { expandedSessionIds: [...expanded], positions, viewport, selection, railCollapsed, showNative });
    const path = updateMapUrl(new URL(location.href), workspace, selection);
    if (`${location.pathname}${location.search}` !== path) history.replaceState({}, "", path);
    if (saved.viewport && !viewport) setViewport(saved.viewport);
  }, [workspace, expanded, positions, viewport, selection, railCollapsed, showNative]);

  useEffect(() => {
    expandedRef.current = expanded;
    for (const sessionId of expanded) {
      if (turns.has(sessionId) || turnStates.has(sessionId)) continue;
      void reloadTurnDirectory(sessionId).catch(() => undefined);
    }
  }, [expanded, turns, turnStates, reloadTurnDirectory]);

  useEffect(() => {
    if (!selection) { setDetail(undefined); setDetailError(""); return; }
    const controller = new AbortController();
    setDetail(undefined); setDetailError("");
    const load = selection.kind === "turn" ? getTurnDetail(selection.sessionId, selection.nativeTurnId, controller.signal) : getSessionDetail(selection.sessionId, controller.signal);
    void load.then(setDetail).catch((error) => { if (!controller.signal.aborted) setDetailError((error as Error).message); });
    return () => controller.abort();
  }, [selection]);

  useEffect(() => {
    if (!bootstrap?.capabilities.liveUpdates) return;
    const events = new EventSource("/api/events");
    events.addEventListener("snapshot", () => {
      if (!workspace) return;
      void reloadForest(workspace);
      for (const sessionId of expandedRef.current) void reloadTurnDirectory(sessionId).catch(() => undefined);
    });
    events.addEventListener("organization-progress", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as OrganizationJobView;
      if (next.workspaceId === workspace) setOrganizationProgress((current) => !current || next.id !== current.id || next.revision > current.revision ? next : current);
    });
    events.addEventListener("ready", () => setEventConnectionRevision((value) => value + 1));
    events.addEventListener("error", () => setNotice("Live updates reconnecting…"));
    return () => events.close();
  }, [bootstrap, workspace, reloadForest, reloadTurnDirectory]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") { draft ? setDraft(undefined) : placement ? setPlacement(undefined) : setSelection(undefined); return; }
      if ((!event.ctrlKey && !event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "z") return;
      if ((event.target as HTMLElement)?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault(); void performUndo();
    };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  });

  const toggle = useCallback((sessionId: string) => setExpanded((current) => {
    if (current.has(sessionId)) { const next = new Set(current); next.delete(sessionId); return next; }
    return limitedExpansion(current, sessionId);
  }), []);
  const graph = useMemo(() => forest ? buildMapGraph({ forest, expanded, turnDirectories: turns, selection, positions, showNative, turnStates, onToggle: toggle, onRetryTurns: (sessionId) => void reloadTurnDirectory(sessionId).catch(() => undefined) }) : { nodes: [], edges: [], bounds: { width: 0, height: 0 } }, [forest, expanded, turns, selection, positions, showNative, turnStates, toggle, reloadTurnDirectory]);
  const [renderNodes, setRenderNodes, onNodesChange] = useNodesState(graph.nodes);
  useEffect(() => setRenderNodes(graph.nodes), [graph.nodes, setRenderNodes]);
  useEffect(() => {
    if (!pendingLocate.current) return;
    const node = renderNodes.find((item) => item.id === pendingLocate.current);
    if (!node) return;
    pendingLocate.current = undefined;
    const parent = node.parentId ? renderNodes.find((item) => item.id === node.parentId) : undefined;
    const x = node.position.x + (parent?.position.x ?? 0) + (node.measured?.width ?? 236) / 2;
    const y = node.position.y + (parent?.position.y ?? 0) + (node.measured?.height ?? 56) / 2;
    requestAnimationFrame(() => void flow.setCenter(x, y, { zoom: Math.max(flow.getZoom(), .78), duration: 280 }));
  }, [renderNodes, flow]);
  useEffect(() => { if (viewport) void flow.setViewport(viewport); }, [workspace]);
  useEffect(() => {
    if (!fitUnseenWorkspace.current || !renderNodes.length) return;
    fitUnseenWorkspace.current = false;
    requestAnimationFrame(() => void flow.fitView({ padding: .12 }).then(() => setViewport(flow.getViewport())));
  }, [renderNodes.length, flow]);

  const select = useCallback((next: Selection) => {
    setSelection(next);
    if (next?.kind === "turn") setExpanded((current) => limitedExpansion(current, next.sessionId));
  }, []);
  const onNodeClick: NodeMouseHandler = useCallback((event, node) => {
    if (node.type === "session" && (event.target as HTMLElement).closest("[data-action='toggle-session']")) return toggle((node.data as any).session.sessionId);
    if (node.type === "session") select({ kind: "session", sessionId: (node.data as any).session.sessionId });
    if (node.type === "turn") select({ kind: "turn", sessionId: (node.data as any).sessionId, nativeTurnId: (node.data as any).turn.nativeTurnId });
  }, [select, toggle]);
  const onConnect = useCallback(async (connection: Connection) => {
    try {
      const next = connectionToPlacement(connection, renderNodes);
      const legal = await getManualParents(next.childSessionId);
      if (!legal.some((candidate) => candidate.sessionId === next.parentSessionId)) throw new Error("Invalid parent: different Workspace, future Session, self-parent, or cycle.");
      setPlacement(next);
    } catch (error) { setNotice((error as Error).message); }
  }, [renderNodes]);

  function selectSearchResult(result: SearchResult) {
    const navigation = resolveSearchNavigation(result, expanded, MAX_EXPANDED);
    pendingLocate.current = navigation.nodeId;
    setExpanded(navigation.expanded); setSelection(navigation.selection);
  }

  async function switchWorkspace(next: string) {
    if (!next || next === workspace) return;
    saveLastWorkspace(localStorage, next);
    const saved = readWorkspaceState(localStorage, next);
    fitUnseenWorkspace.current = !saved.viewport;
    setWorkspace(next); setForest(undefined); setTurns(new Map()); setExpanded(new Set(saved.expandedSessionIds)); setPositions(saved.positions);
    setSelection(saved.selection); setViewport(saved.viewport); setShowNative(Boolean(saved.showNative)); setRailCollapsed(Boolean(saved.railCollapsed));
    await reloadForest(next);
    if (saved.viewport) await flow.setViewport(saved.viewport);
  }
  async function confirmPlacement() {
    if (!placement) return;
    try {
      const result = await writePlacement(placement.childSessionId, { relation: placement.relation, parentSessionId: placement.parentSessionId, anchorTurnId: placement.anchorTurnId });
      setLastEdit(result.edit); setPlacement(undefined); setNotice("Moved Session · Undo available"); await reloadForest(workspace);
    } catch (error) { setNotice((error as Error).message); }
  }
  async function performUndo() {
    try {
      const edit = lastEdit ?? await latestEdit(workspace);
      if (!edit) throw new Error("No recent manual change to undo.");
      await undoEdit(edit.id, edit.revision); setLastEdit(undefined); setNotice("Manual change undone"); await reloadForest(workspace);
      if (selection?.kind === "turn") await reloadTurnDirectory(selection.sessionId);
      if (selection) setDetail(selection.kind === "turn" ? await getTurnDetail(selection.sessionId, selection.nativeTurnId) : await getSessionDetail(selection.sessionId));
    } catch (error) { setNotice((error as Error).message); }
  }
  async function setRoot(sessionId: string) {
    try { const result = await writePlacement(sessionId, { relation: "root" }); setLastEdit(result.edit); setNotice("Session set as root · Undo available"); await reloadForest(workspace); setDetail(await getSessionDetail(sessionId)); }
    catch (error) { setNotice((error as Error).message); }
  }
  async function saveDraft() {
    if (!draft || !selection) return;
    const field = draft.kind;
    const sessionId = selection.sessionId;
    try {
      const current = await getOverride(sessionId, field, selection.kind === "turn" ? selection.nativeTurnId : undefined);
      const value = field === "title" ? { title: draft.value } : { label: draft.value };
      const result = await writeOverride(sessionId, field, value, current.override.revision, selection.kind === "turn" ? selection.nativeTurnId : undefined);
      setLastEdit(result.edit); setDraft(undefined); setNotice(`${field === "title" ? "Session renamed" : "Turn label updated"} · Undo available`);
      if (field === "title") setForest((current) => patchSessionTitle(current, sessionId, result.semanticTitle?.displayTitle));
      if (selection.kind === "turn") await reloadTurnDirectory(sessionId);
      setDetail(selection.kind === "turn" ? await getTurnDetail(sessionId, selection.nativeTurnId) : await getSessionDetail(sessionId));
    } catch (error) { setNotice((error as Error).message); }
  }
  async function restoreAutomatic(field: "title" | "label" | "parent") {
    if (!selection) return;
    try {
      const current = await getOverride(selection.sessionId, field, selection.kind === "turn" ? selection.nativeTurnId : undefined);
      const result = await writeOverride(selection.sessionId, field, null, current.override.revision, selection.kind === "turn" ? selection.nativeTurnId : undefined);
      setLastEdit(result.edit); setNotice("Automatic suggestion restored · Undo available");
      if (field === "title") setForest((current) => patchSessionTitle(current, selection.sessionId, result.semanticTitle?.displayTitle));
      if (field === "parent") await reloadForest(workspace);
      if (selection.kind === "turn") await reloadTurnDirectory(selection.sessionId);
      setDetail(selection.kind === "turn" ? await getTurnDetail(selection.sessionId, selection.nativeTurnId) : await getSessionDetail(selection.sessionId));
    } catch (error) { setNotice((error as Error).message); }
  }
  const sessions = forest ? flattenSessions([...forest.roots, ...forest.unorganized]) : [];
  const selectedNode = selection ? sessions.find((session) => session.sessionId === selection.sessionId) : undefined;
  const legacyPath = selection?.kind === "turn"
    ? `/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(selection.sessionId)}/turns/${encodeURIComponent(selection.nativeTurnId)}`
    : selection ? `/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(selection.sessionId)}` : `/workspaces/${encodeURIComponent(workspace)}`;
  const legacyHref = search.query ? `${legacyPath}?q=${encodeURIComponent(search.query)}` : legacyPath;

  return <main className={`map-shell ${railCollapsed ? "rail-collapsed" : ""}`}>
    <header className="map-topbar">
      <button className="brand" type="button" onClick={() => setRailCollapsed((value) => !value)}>Codex Session Map</button>
      <select aria-label="Workspace" value={workspace} onChange={(event) => void switchWorkspace(event.target.value)}>{bootstrap?.scopes.map((scope) => <option key={scope.id} value={scope.id}>{scope.displayName}</option>)}</select>
      <SearchPanel query={search.query} setQuery={search.setQuery} results={search.page?.results ?? []} index={search.index} loading={search.loading} error={search.error} nextCursor={search.page?.nextCursor} loadMore={() => void search.loadMore()} onSelect={selectSearchResult} />
      <div className="view-tabs"><button className="active" type="button">Map</button><a href={legacyHref}>List</a></div>
      <OrganizationControl workspace={workspace} available={Boolean(bootstrap?.organizer?.available)} selectedSessionId={selection?.sessionId} expandedSessionIds={[...expanded]} liveJob={organizationProgress} connectionRevision={eventConnectionRevision} onNotice={setNotice} onComplete={() => { void reloadForest(workspace); for (const sessionId of expandedRef.current) void reloadTurnDirectory(sessionId).catch(() => undefined); }} onProgress={(item) => { if (item?.operation === "trace") { if (expandedRef.current.has(item.sessionId)) void reloadTurnDirectory(item.sessionId).catch(() => undefined); } else if (item?.operation === "title") void reloadSessionTitle(item.sessionId).catch(() => undefined); else void reloadForest(workspace); }} />
      <button type="button" className="subtle" onClick={() => void performUndo()}>Undo</button>
    </header>
    <aside className="workspace-rail">
      <button type="button" className="rail-toggle" onClick={() => setRailCollapsed((value) => !value)}>{railCollapsed ? "›" : "‹"}</button>
      <h2>Workspace</h2><p>{forest?.stats.confirmedRoots ?? 0} roots · {forest?.stats.sessions ?? 0} Sessions</p>
      <nav><button className="active" type="button">Work evolution</button><button type="button">Recent</button><button type="button">Unorganized <span>{forest?.stats.unorganized ?? 0}</span></button></nav>
      <div className="rail-sessions">{sessions.slice(0, 12).map((session) => <button type="button" className={selection?.sessionId === session.sessionId ? "selected" : ""} key={session.sessionId} onClick={() => select({ kind: "session", sessionId: session.sessionId })}>{session.displayTitle}</button>)}</div>
      <div className="legend"><h3>Relations</h3><p><i className="solid" /> User semantic</p><p><i className="dashed" /> AI semantic</p><p><i className="native" /> Native origin</p></div>
    </aside>
    <section className="map-stage" aria-label="Session–Turn Work Evolution Map">
      <div className="map-toolbar"><div><strong>Work evolution</strong><span>{forest?.stats.confirmedRoots ?? 0} roots · {forest?.stats.sessions ?? 0} Sessions · {expanded.size} expanded</span></div><label><input type="checkbox" checked={showNative} onChange={(event) => setShowNative(event.target.checked)} /> Show native lineage</label><button type="button" onClick={() => void flow.fitView({ padding: .12, duration: 300 }).then(() => setViewport(flow.getViewport()))}>Fit view</button></div>
      {loading && <div className="map-centered-state">Loading Workspace map…</div>}
      {forestError && <div className="map-centered-state error"><strong>Unable to load map</strong><span>{forestError}</span><button type="button" onClick={() => void reloadForest(workspace)}>Retry</button></div>}
      {forest && <ReactFlow
        nodes={renderNodes} edges={graph.edges} nodeTypes={nodeTypes as any} minZoom={.22} maxZoom={1.8} defaultViewport={viewport ?? { x: 70, y: 72, zoom: .82 }}
        onNodesChange={onNodesChange} onNodeClick={onNodeClick} onConnect={onConnect} nodesConnectable nodesDraggable panOnDrag selectionOnDrag
        onNodeDragStop={(_, node) => node.type === "session" && setPositions((current) => ({ ...current, [node.id]: node.position }))}
        onMoveEnd={(_, next: Viewport) => setViewport(next)}
      ><Background gap={26} size={1} color="#dbe2dc" /><MiniMap pannable zoomable nodeStrokeWidth={3} /><Controls showInteractive={false} /></ReactFlow>}
      <output className="map-notice">{notice}{lastEdit && <button type="button" onClick={() => void performUndo()}>Undo</button>}</output>
    </section>
    {selection && <DetailDrawer selection={selection} session={selectedNode} turn={selection.kind === "turn" ? turns.get(selection.sessionId)?.find((item) => item.nativeTurnId === selection.nativeTurnId) : undefined} directory={selection.kind === "turn" ? turns.get(selection.sessionId) ?? [] : []} detail={detail} error={detailError} onNavigateTurn={(turn: TurnDirectoryItem) => select({ kind: "turn", sessionId: selection.sessionId, nativeTurnId: turn.nativeTurnId })} draft={draft} setDraft={setDraft} saveDraft={saveDraft} restoreAutomatic={restoreAutomatic} setRoot={setRoot} close={() => setSelection(undefined)} beginMove={async () => {
      try { const candidates = await getManualParents(selection.sessionId); setPlacement({ childSessionId: selection.sessionId, parentSessionId: candidates[0]?.sessionId ?? "", relation: selectedNode?.semanticRelation === "continuation" ? "continuation" : "subtask", legalParentIds: candidates.map((candidate) => candidate.sessionId) }); }
      catch (error) { setNotice((error as Error).message); }
    }} />}
    {placement && <PlacementPanel draft={placement} setDraft={setPlacement} forest={forest} turns={turns} loadTurns={async (sessionId: string) => { const directory = await getTurnDirectory(sessionId); setTurns((current) => new Map(current).set(sessionId, directory)); return directory; }} confirm={confirmPlacement} cancel={() => setPlacement(undefined)} />}
  </main>;
}

function DetailDrawer(props: any) {
  const title = props.selection.kind === "turn" ? props.detail?.semanticTrace?.navigationLabel ?? props.turn?.displayLabel ?? `Turn ${props.selection.nativeTurnId}` : props.detail?.semanticTitle?.displayTitle ?? props.session?.displayTitle;
  const heading = props.selection.kind === "turn" && props.turn ? `T${props.turn.displayOrdinal} · ${title}` : title;
  return <aside className="detail-drawer"><button type="button" className="drawer-close" aria-label="Close detail" onClick={props.close}>×</button><span className="drawer-kicker">{props.selection.kind} detail</span><h2>{heading ?? "Loading…"}</h2>
    {props.error && props.selection.kind === "session" && <p className="drawer-error">{props.error} <button type="button" onClick={props.close}>Close</button></p>}
    {props.selection.kind === "session" ? <><p>{props.detail?.semanticParent?.relation ? `${props.detail.semanticParent.relation} · ${props.detail.semanticParent.authority}` : "Unorganized"}</p><dl><dt>Turns</dt><dd>{props.session?.turnCount}</dd><dt>Original title</dt><dd>{props.detail?.semanticTitle?.originalTitle ?? props.session?.originalTitle}</dd><dt>Semantic anchor</dt><dd>{props.detail?.semanticParent?.anchorTurnId ?? "Session level"}</dd><dt>Native origin</dt><dd>{props.detail?.semanticParent?.nativeLineage?.originTurnId ?? "None"}</dd></dl></> : <TurnReader nativeTurnId={props.selection.nativeTurnId} directory={props.directory} detail={props.detail} error={props.error} onNavigate={props.onNavigateTurn} />}
    {props.draft ? <div className="drawer-edit"><textarea autoFocus value={props.draft.value} onChange={(event) => props.setDraft({ ...props.draft, value: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void props.saveDraft(); } }} /><button type="button" onClick={props.saveDraft}>Save</button><button type="button" onClick={() => props.setDraft(undefined)}>Cancel</button></div> : <div className="drawer-actions">
      <button type="button" onClick={() => props.setDraft({ kind: props.selection.kind === "turn" ? "label" : "title", value: title ?? "" })}>{props.selection.kind === "turn" ? "Edit label" : "Rename"}</button>
      {props.selection.kind === "session" && <><button type="button" onClick={props.beginMove}>Move</button><button type="button" onClick={() => props.setRoot(props.selection.sessionId)}>Set root</button></>}
      <button type="button" onClick={() => props.restoreAutomatic(props.selection.kind === "turn" ? "label" : "title")}>Restore automatic</button>
      {props.selection.kind === "session" && <button type="button" onClick={() => props.restoreAutomatic("parent")}>Restore automatic placement</button>}
    </div>}
  </aside>;
}

function PlacementPanel(props: any) {
  const sessions = props.forest ? flattenSessions([...props.forest.roots, ...props.forest.unorganized]).filter((item: SessionNodeData) => item.sessionId !== props.draft.childSessionId && (!props.draft.legalParentIds || props.draft.legalParentIds.includes(item.sessionId))) : [];
  const directory = props.turns.get(props.draft.parentSessionId) ?? [];
  useEffect(() => { if (props.draft.parentSessionId && !props.turns.has(props.draft.parentSessionId)) void props.loadTurns(props.draft.parentSessionId); }, [props.draft.parentSessionId]);
  return <div className="placement-popover" role="dialog" aria-label="Move Session"><strong>Move Session</strong><label>Parent Session<select value={props.draft.parentSessionId} onChange={(event) => props.setDraft({ ...props.draft, parentSessionId: event.target.value, anchorTurnId: undefined })}><option value="">Choose parent…</option>{sessions.map((session: SessionNodeData) => <option key={session.sessionId} value={session.sessionId}>{session.displayTitle}</option>)}</select></label><label>Optional anchor Turn<select value={props.draft.anchorTurnId ?? ""} onChange={(event) => props.setDraft({ ...props.draft, anchorTurnId: event.target.value || undefined })}><option value="">Session level</option>{directory.map((turn: TurnDirectoryItem) => <option key={turn.nativeTurnId} value={turn.nativeTurnId}>T{turn.displayOrdinal} {turn.displayLabel}</option>)}</select></label><label>Relation<select value={props.draft.relation} onChange={(event) => props.setDraft({ ...props.draft, relation: event.target.value as Relation })}><option value="continuation">continuation</option><option value="subtask">subtask</option></select></label><p>Move under {props.draft.parentSessionId || "…"}{props.draft.anchorTurnId ? ` / ${props.draft.anchorTurnId}` : " at Session level"}</p><div><button type="button" disabled={!props.draft.parentSessionId} onClick={props.confirm}>Confirm</button><button type="button" onClick={props.cancel}>Cancel</button></div></div>;
}

function limitedExpansion(current: ReadonlySet<string>, sessionId: string): Set<string> {
  const values = [...current].filter((value) => value !== sessionId); values.push(sessionId);
  return new Set(values.slice(-MAX_EXPANDED));
}
