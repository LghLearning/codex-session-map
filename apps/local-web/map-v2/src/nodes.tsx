import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { SessionMapNodeData, TurnMapNodeData, SectionMapNodeData } from "./types.ts";

export function SessionNode({ data }: NodeProps & { data: SessionMapNodeData }) {
  const { session, expanded, selected } = data;
  return <article className={`map-session-node ${selected ? "is-selected" : ""} ${expanded ? "is-expanded" : ""}`}>
    <Handle id="branch-in" type="target" position={Position.Left} className="map-handle branch-in" />
    <Handle id="branch-out" type="source" position={Position.Right} className="map-handle branch-out" />
    <header>
      <span className="session-kicker">Session</span>
      <button type="button" className="expand-control nodrag" aria-label={expanded ? "Collapse Session" : "Expand Session"} data-action="toggle-session" onClick={(event) => { if (!data.onToggle) return; event.stopPropagation(); data.onToggle(session.sessionId); }}>{expanded ? "−" : "+"}</button>
    </header>
    <strong title={session.displayTitle}>{session.displayTitle}</strong>
    <p>{session.turnCount} Turns <span>·</span> {formatRelative(session.updatedAt)}</p>
    {data.turnState === "loading" && <span className="turn-load-state">Loading Turn sequence…</span>}
    {data.turnState === "error" && <span className="turn-load-state error">Turn sequence unavailable <button type="button" className="nodrag" onClick={(event) => { event.stopPropagation(); data.onRetryTurns?.(session.sessionId); }}>Retry</button></span>}
    <span className={`relation-mark ${session.placementSource}`}>{session.placementSource === "none" ? "Not organized yet" : session.placementSource === "user" ? "User placement" : "AI suggestion"}</span>
    <Handle id="reparent" type="source" position={Position.Bottom} className="map-handle relation-handle" title="Drag to a parent Session or Turn" />
  </article>;
}

export function TurnNode({ data }: NodeProps & { data: TurnMapNodeData }) {
  return <article className={`map-turn-node ${data.selected ? "is-selected" : ""}`} title={data.turn.displayLabel}>
    <Handle id="chain-in" type="target" position={Position.Top} className="chain-handle" />
    <Handle id="chain-out" type="source" position={Position.Bottom} className="chain-handle" />
    <Handle id="branch-out" type="source" position={Position.Right} className="map-handle branch-out" />
    <Handle id="relation-target" type="target" position={Position.Right} className="map-handle relation-target" />
    <span>T{data.turn.displayOrdinal}</span>
    <strong>{data.turn.displayLabel}</strong>
  </article>;
}

export function SectionNode({ data }: NodeProps & { data: SectionMapNodeData }) {
  return <div className="map-section-label">{data.label}</div>;
}

function formatRelative(value?: string): string {
  if (!value) return "time unknown";
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86_400_000));
  return days === 0 ? "updated today" : `updated ${days}d ago`;
}
