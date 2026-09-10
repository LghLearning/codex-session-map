import { useState, type ReactNode } from "react";
import type { SearchIndexStatus, SearchResult } from "../types.ts";
import "./search.css";

const SOURCE_LABELS = { session_title: "Session title", turn_label: "Turn label", turn_summary: "Summary", user_input: "User input", assistant_final: "Assistant answer" } as const;

export function SearchPanel(props: {
  query: string; setQuery(value: string): void; results: readonly SearchResult[]; index: SearchIndexStatus;
  loading: boolean; error?: string; nextCursor?: string; loadMore(): void; onSelect(result: SearchResult): void;
}) {
  const [active, setActive] = useState(0);
  const open = Boolean(props.query.trim());
  const choose = (index: number) => { const result = props.results[index]; if (result) { setActive(index); props.onSelect(result); } };
  return <div className="workspace-search">
    <input aria-label="Search Workspace" placeholder="Search past discussion…" value={props.query} onChange={(event) => { setActive(0); props.setQuery(event.target.value); }} onKeyDown={(event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(props.results.length - 1, value + 1)); }
      if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
      if (event.key === "Enter") { event.preventDefault(); choose(active); }
      if (event.key === "Escape") props.setQuery("");
    }} />
    {open && <section className="search-results" aria-label="Workspace search results">
      <header><strong>{props.loading ? "Searching…" : `${props.results.length} results`}</strong><IndexState index={props.index} /></header>
      {props.error && <p className="search-error">Search unavailable: {props.error}</p>}
      {!props.loading && !props.error && props.results.length === 0 && <p className="search-empty">{props.index.state === "indexing" ? "No matches in indexed content yet." : "No matches."}</p>}
      <div className="search-result-list">{props.results.map((result, index) => <button type="button" className={index === active ? "active" : ""} key={`${result.sessionId}:${result.nativeTurnId ?? "session"}:${result.sourceKind}`} onClick={() => choose(index)}>
        <span><strong>{result.sessionTitle}</strong><small>{result.nativeTurnId ? `T${result.displayOrdinal} · ` : ""}{SOURCE_LABELS[result.sourceKind]}{result.timestamp ? ` · ${new Date(result.timestamp).toLocaleDateString()}` : ""}</small></span>
        <SearchSnippet text={result.snippet} highlights={result.highlights} />
      </button>)}</div>
      <footer><button type="button" disabled={active <= 0} onClick={() => choose(active - 1)}>Previous</button><button type="button" disabled={active >= props.results.length - 1} onClick={() => choose(active + 1)}>Next</button>{props.nextCursor && <button type="button" disabled={props.loading} onClick={props.loadMore}>More</button>}</footer>
    </section>}
  </div>;
}

function IndexState({ index }: { index: SearchIndexStatus }) {
  if (index.state === "ready") return <small>{index.indexedTurns} Turns indexed</small>;
  if (index.state === "error") return <small className="search-error">Index unavailable</small>;
  return <small>Indexing · {Math.round(index.coverage * 100)}% ready</small>;
}
export function SearchSnippet({ text, highlights }: { text: string; highlights: readonly { start: number; end: number }[] }) {
  const parts: ReactNode[] = []; let cursor = 0;
  for (const [index, range] of highlights.entries()) {
    if (range.start > cursor) parts.push(<span key={`t${index}`}>{text.slice(cursor, range.start)}</span>);
    parts.push(<mark key={`m${index}`}>{text.slice(range.start, range.end)}</mark>); cursor = range.end;
  }
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>);
  return <p>{parts}</p>;
}
