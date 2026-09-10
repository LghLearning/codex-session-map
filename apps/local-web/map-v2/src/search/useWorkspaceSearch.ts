import { useEffect, useRef, useState } from "react";
import { getSearchStatus, searchWorkspace } from "../api.ts";
import type { SearchIndexStatus, SearchPage } from "../types.ts";

const EMPTY_INDEX: SearchIndexStatus = { state: "idle", totalSessions: 0, indexedSessions: 0, indexedTurns: 0, coverage: 0 };

export function useWorkspaceSearch(workspace: string, available: boolean) {
  const [query, setQuery] = useState(() => new URL(location.href).searchParams.get("q") ?? "");
  const [page, setPage] = useState<SearchPage>();
  const [index, setIndex] = useState<SearchIndexStatus>(EMPTY_INDEX);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);

  useEffect(() => {
    const url = new URL(location.href);
    query ? url.searchParams.set("q", query) : url.searchParams.delete("q");
    history.replaceState({}, "", `${url.pathname}${url.search}`);
  }, [query]);

  useEffect(() => {
    if (!workspace || !available) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await getSearchStatus(workspace, controller.signal); setIndex(next);
        if (next.state === "indexing" || next.state === "idle") timer = window.setTimeout(poll, 700);
      } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [workspace, available]);

  useEffect(() => {
    const request = ++sequence.current;
    if (!workspace || !available || !query.trim()) { setPage(undefined); setLoading(false); setError(""); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void searchWorkspace(workspace, query, { signal: controller.signal }).then((next) => {
        if (request !== sequence.current) return;
        setPage(next); setIndex(next.index); setError("");
      }).catch((reason) => { if (!controller.signal.aborted && request === sequence.current) setError((reason as Error).message); })
        .finally(() => { if (request === sequence.current) setLoading(false); });
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [workspace, available, query]);

  async function loadMore() {
    if (!page?.nextCursor) return;
    const request = ++sequence.current; setLoading(true);
    try {
      const next = await searchWorkspace(workspace, query, { cursor: page.nextCursor });
      if (request !== sequence.current) return;
      setPage({ ...next, results: [...page.results, ...next.results] }); setIndex(next.index);
    } catch (reason) { if (request === sequence.current) setError((reason as Error).message); }
    finally { if (request === sequence.current) setLoading(false); }
  }

  return { query, setQuery, page, index, loading, error, loadMore };
}
