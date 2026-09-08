import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type Connection, type NodeMouseHandler, type Viewport } from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";
import { buildMapGraph } from "./graph.ts";
import { prototypeForest, prototypeTurns } from "./fixture.ts";
import { SectionNode, SessionNode, TurnNode } from "./nodes.tsx";
import type { PersistedWorkspaceState, Selection } from "./types.ts";

const nodeTypes = { session: SessionNode, turn: TurnNode, section: SectionNode };

export default function App() {
  return <ReactFlowProvider><MapPrototype /></ReactFlowProvider>;
}

function MapPrototype() {
  const flow = useReactFlow();
  const [expanded, setExpanded] = useState(() => new Set(["a", "g"]));
  const [selection, setSelection] = useState<Selection>();
  const [positions, setPositions] = useState<PersistedWorkspaceState["positions"]>({});
  const [showNative, setShowNative] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [notice, setNotice] = useState("Prototype fixture · no private data");
  const graph = useMemo(() => buildMapGraph({ forest: prototypeForest, expanded, turnDirectories: prototypeTurns, selection, positions, showNative }), [expanded, selection, positions, showNative]);

  const onNodeClick: NodeMouseHandler = useCallback((event, node) => {
    const action = (event.target as HTMLElement).closest("[data-action='toggle-session']");
    if (node.type === "session" && action) {
      const sessionId = node.id.slice("session:".length);
      setExpanded((current) => { const next = new Set(current); next.has(sessionId) ? next.delete(sessionId) : next.add(sessionId); return next; });
      return;
    }
    if (node.type === "session") setSelection({ kind: "session", sessionId: node.id.slice("session:".length) });
    if (node.type === "turn") {
      const data = node.data as any;
      setSelection({ kind: "turn", sessionId: data.sessionId, nativeTurnId: data.turn.nativeTurnId });
    }
  }, []);
  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source.startsWith("session:") || !connection.target) return setNotice("Start relationship edits from a Session relationship handle.");
    const child = connection.source.slice("session:".length);
    const target = connection.target;
    const parent = target.startsWith("session:") ? target.slice("session:".length) : (target.startsWith("turn:") ? (graph.nodes.find((node) => node.id === target)?.data as any)?.sessionId : undefined);
    if (!parent || parent === child) return setNotice("Invalid relationship: a Session cannot parent itself.");
    const anchor = target.startsWith("turn:") ? (graph.nodes.find((node) => node.id === target)?.data as any)?.turn.nativeTurnId : undefined;
    setNotice(`Preview: move Session ${child} under Session ${parent}${anchor ? ` / ${anchor}` : " at Session level"}. Real saves are enabled after API connection.`);
  }, [graph.nodes]);
  const selectionLabel = selection?.kind === "session"
    ? prototypeForest.roots.concat(prototypeForest.unorganized).flatMap(flatten).find((item) => item.sessionId === selection.sessionId)?.displayTitle
    : selection?.kind === "turn" ? prototypeTurns.get(selection.sessionId)?.find((turn) => turn.nativeTurnId === selection.nativeTurnId)?.displayLabel : undefined;

  return <main className={`map-shell ${railCollapsed ? "rail-collapsed" : ""}`}>
    <header className="map-topbar">
      <button className="brand" type="button" onClick={() => setRailCollapsed((value) => !value)}>Codex Session Map</button>
      <select aria-label="Workspace"><option>Prototype Workspace</option></select>
      <input aria-label="Locate Session title" placeholder="Locate Session title…" />
      <div className="view-tabs"><button className="active" type="button">Map</button><a href="/legacy">List</a></div>
      <button type="button" className="subtle">Organize</button>
    </header>
    <aside className="workspace-rail">
      <button type="button" className="rail-toggle" onClick={() => setRailCollapsed((value) => !value)}>{railCollapsed ? "›" : "‹"}</button>
      <h2>Workspace</h2><p>3 areas · 15 Sessions</p>
      <nav><button className="active" type="button">Work evolution</button><button type="button">Recent</button><button type="button">Unorganized <span>3</span></button></nav>
      <div className="legend"><h3>Relations</h3><p><i className="solid" /> Semantic placement</p><p><i className="dashed" /> AI suggestion</p><p><i className="native" /> Native origin</p></div>
    </aside>
    <section className="map-stage" aria-label="Session–Turn Work Evolution Map">
      <div className="map-toolbar">
        <div><strong>Work evolution</strong><span>{prototypeForest.stats.confirmedRoots} roots · {prototypeForest.stats.sessions} Sessions · {expanded.size} expanded</span></div>
        <label><input type="checkbox" checked={showNative} onChange={(event) => setShowNative(event.target.checked)} /> Show native lineage</label>
        <button type="button" onClick={() => flow.fitView({ padding: 0.12, duration: 300 })}>Fit view</button>
      </div>
      <ReactFlow
        nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes as any} minZoom={0.22} maxZoom={1.8}
        defaultViewport={{ x: 70, y: 72, zoom: 0.82 }} nodesConnectable nodesDraggable panOnDrag selectionOnDrag
        onNodeClick={onNodeClick} onConnect={onConnect}
        onNodeDragStop={(_, node) => node.type === "session" && setPositions((current) => ({ ...current, [node.id]: node.position }))}
        onMoveEnd={(_, viewport: Viewport) => void viewport}
      >
        <Background gap={26} size={1} color="#dbe2dc" /><MiniMap pannable zoomable nodeStrokeWidth={3} /><Controls showInteractive={false} />
      </ReactFlow>
      <output className="map-notice">{notice}</output>
    </section>
    {selection && <aside className="detail-drawer">
      <button type="button" className="drawer-close" aria-label="Close detail" onClick={() => setSelection(undefined)}>×</button>
      <span className="drawer-kicker">{selection.kind === "turn" ? "Turn detail" : "Session detail"}</span>
      <h2>{selectionLabel}</h2>
      <p>{selection.kind === "turn" ? "Full Turn content loads only after selection." : "Relationship, provenance and recent context appear here."}</p>
      <dl><dt>Identity</dt><dd>{selection.kind === "turn" ? selection.nativeTurnId : selection.sessionId}</dd><dt>Source</dt><dd>Fixture projection</dd></dl>
      <div className="drawer-actions"><button type="button">Edit</button><button type="button">Move</button><button type="button">Set root</button></div>
    </aside>}
  </main>;
}

function flatten(node: any): any[] { return [node, ...node.children.flatMap(flatten)]; }
