import type { TurnDirectoryItem } from "../types.ts";
import { MarkdownContent } from "./MarkdownContent.tsx";
import "./reader.css";

export function TurnReader(props: {
  nativeTurnId: string; directory: readonly TurnDirectoryItem[]; detail?: any; error?: string;
  onNavigate(turn: TurnDirectoryItem): void;
}) {
  const index = props.directory.findIndex((turn) => turn.nativeTurnId === props.nativeTurnId);
  const previous = index > 0 ? props.directory[index - 1] : undefined;
  const next = index >= 0 ? props.directory[index + 1] : undefined;
  const detail = props.detail;
  return <div className="turn-reader">
    <nav className="reader-neighbors" aria-label="Neighboring Turns"><button type="button" disabled={!previous} onClick={() => previous && props.onNavigate(previous)}>← Previous Turn</button><button type="button" disabled={!next} onClick={() => next && props.onNavigate(next)}>Next Turn →</button></nav>
    {props.error && <p className="drawer-error">Exact Turn read failed: {props.error}</p>}
    {!detail && !props.error && <p className="reader-loading">Loading exact Turn content…</p>}
    {detail?.semanticTrace?.displayText && <section className="reader-summary"><h3>Summary</h3><p>{detail.semanticTrace.displayText}</p></section>}
    {detail && <>
      <section className="reader-section"><h3>User Input</h3><div className="markdown-body"><MarkdownContent value={detail.input} /></div></section>
      <section className="reader-section"><h3>Assistant Final</h3><div className="markdown-body"><MarkdownContent value={detail.assistantFinal} /></div></section>
      <ToolActivity tools={detail.tools ?? []} />
      <details className="reader-source"><summary>Source and provenance</summary><dl><dt>Native Turn ID</dt><dd>{detail.id}</dd><dt>Status</dt><dd>{detail.status}</dd><dt>Started</dt><dd>{detail.startedAt ?? "Unknown"}</dd><dt>Completed</dt><dd>{detail.completedAt ?? "Unknown"}</dd></dl></details>
    </>}
  </div>;
}

function ToolActivity({ tools }: { tools: any[] }) {
  if (!tools.length) return null;
  return <details className="tool-activity"><summary>Tools · {tools.length} actions</summary>{tools.map((tool, index) => <article key={tool.callId ?? `${tool.name}:${index}`}><strong>{tool.name}</strong><span>{tool.status}</span>{tool.inputSummary && <p>{tool.inputSummary}</p>}{tool.outputSummary && <p>{tool.outputSummary}</p>}</article>)}</details>;
}
