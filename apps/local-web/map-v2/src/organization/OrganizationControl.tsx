import { useEffect, useRef, useState } from "react";
import { controlOrganization, getLatestOrganization, getOrganization, getOrganizationItems, startOrganization, type OrganizationItemView, type OrganizationJobView, type OrganizationMode } from "../api.ts";

const ACTIVE = new Set(["queued", "running", "pausing", "canceling"]);

export function OrganizationControl(props: {
  workspace: string;
  available: boolean;
  selectedSessionId?: string;
  expandedSessionIds: readonly string[];
  onProgress(item?: OrganizationJobView["lastCommitted"]): void;
  onNotice(message: string): void;
}) {
  const [job, setJob] = useState<OrganizationJobView>();
  const [open, setOpen] = useState(false);
  const [failures, setFailures] = useState<OrganizationItemView[]>([]);
  const lastGenerated = useRef(0);
  const callback = useRef(props.onProgress);
  callback.current = props.onProgress;

  useEffect(() => {
    if (!props.workspace || !props.available) { setJob(undefined); return; }
    let disposed = false;
    void getLatestOrganization(props.workspace).then((value) => { if (!disposed) { setJob(value); lastGenerated.current = value?.counts.generated ?? 0; } }).catch(() => undefined);
    return () => { disposed = true; };
  }, [props.workspace, props.available]);

  useEffect(() => {
    if (!job || !ACTIVE.has(job.status)) return;
    let disposed = false;
    const timer = setInterval(() => void getOrganization(job.id).then((next) => {
      if (disposed) return;
      if (next.counts.generated !== lastGenerated.current) { lastGenerated.current = next.counts.generated; callback.current(next.lastCommitted); }
      setJob(next);
    }).catch((error) => props.onNotice((error as Error).message)), 600);
    return () => { disposed = true; clearInterval(timer); };
  }, [job?.id, job?.status]);

  async function start(mode: OrganizationMode, sessionOnly = false, staleOnly = false) {
    try {
      const next = await startOrganization(props.workspace, {
        mode, sessionId: sessionOnly ? props.selectedSessionId : undefined,
        selectedSessionId: props.selectedSessionId, expandedSessionIds: props.expandedSessionIds, staleOnly,
      });
      lastGenerated.current = next.counts.generated; setJob(next); setOpen(true);
    } catch (error) { props.onNotice((error as Error).message); }
  }

  async function control(action: "pause" | "resume" | "cancel" | "retry") {
    if (!job) return;
    try { setJob(await controlOrganization(job.id, action)); }
    catch (error) { props.onNotice((error as Error).message); }
  }

  const active = Boolean(job && ACTIVE.has(job.status));
  return <div className="organization-control">
    <button type="button" className="subtle" disabled={!props.available} title={props.available ? "Organize this Workspace" : "AI organization unavailable"} onClick={() => setOpen((value) => !value)}>{active ? "Organizing…" : "Organize"}</button>
    {open && <section className="organization-panel" aria-label="Organization status">
      <header><strong>{job ? `${job.mode === "quick" ? "Quick" : "Full"} Organization` : "Organize Workspace"}</strong><button type="button" aria-label="Close" onClick={() => setOpen(false)}>×</button></header>
      {!job && <><p>Quick builds the Session map. Full also updates Turn labels.</p><div className="organization-actions"><button type="button" onClick={() => void start("quick")}>Quick</button><button type="button" onClick={() => void start("full")}>Full</button></div>{props.selectedSessionId && <div className="organization-actions"><button type="button" onClick={() => void start("quick", true)}>Quick this Session</button><button type="button" onClick={() => void start("full", true)}>Full this Session</button></div>}</>}
      {job && <>
        <p className={`organization-state ${job.status}`}>{label(job.status)}</p>
        <Operation label="Traces" value={job.counts.byOperation.trace} hidden={job.mode === "quick"} />
        <Operation label="Titles" value={job.counts.byOperation.title} />
        <Operation label="Relationships" value={job.counts.byOperation.parent} />
        <p className="organization-summary">{job.counts.reused} reused · {job.counts.failed + job.counts.stale} failed/stale</p>
        {job.error && <p className="organization-error">{job.error}</p>}
        <div className="organization-actions">
          {(job.status === "running" || job.status === "queued") && <button type="button" onClick={() => void control("pause")}>Pause</button>}
          {(job.status === "paused" || job.status === "interrupted") && <button type="button" onClick={() => void control("resume")}>Continue</button>}
          {ACTIVE.has(job.status) || job.status === "paused" || job.status === "interrupted" ? <button type="button" onClick={() => void control("cancel")}>Cancel</button> : null}
          {(job.status === "completed_with_failures" || job.status === "failed" || job.status === "canceled") && <button type="button" onClick={() => void control("retry")}>Retry failed</button>}
          {(job.counts.failed > 0 || job.counts.stale > 0) && <button type="button" onClick={() => void getOrganizationItems(job.id).then((items) => setFailures(items.filter((item) => item.status === "failed" || item.status === "stale")))}>View failures</button>}
          {!active && <button type="button" onClick={() => { setJob(undefined); }}>New organization</button>}
        </div>
        {props.selectedSessionId && !active && <button className="organization-session" type="button" onClick={() => void start(job.mode, true)}>Organize selected Session</button>}
        {!active && <button className="organization-session" type="button" onClick={() => void start(job.mode, false, true)}>Update stale content</button>}
        {failures.length > 0 && <ul className="organization-failures">{failures.slice(0, 8).map((item) => <li key={item.id}><strong>{item.operation}</strong> · {item.error ?? item.errorCode}</li>)}</ul>}
      </>}
    </section>}
  </div>;
}

function Operation(props: { label: string; value: OrganizationJobView["counts"]["byOperation"]["trace"]; hidden?: boolean }) {
  if (props.hidden) return null;
  return <div className="organization-operation"><span>{props.label}</span><strong>{props.value.completed} / {props.value.planned}</strong><progress max={Math.max(1, props.value.planned)} value={props.value.completed} /></div>;
}

function label(status: OrganizationJobView["status"]): string {
  return ({ queued: "Queued", running: "Running", pausing: "Pausing after current item", paused: "Paused", canceling: "Canceling", canceled: "Canceled", completed: "Complete", completed_with_failures: "Completed with failures", interrupted: "Interrupted — continue when ready", failed: "Failed" })[status];
}
