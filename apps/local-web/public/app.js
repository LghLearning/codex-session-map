import { buildNavigationPath, parseNavigationPath, resolveNavigationAvailability } from "./navigation-state.js";
import { recordInteractionPerformance, recordNavigationPerformance } from "./performance-harness.js";
import { TOOL_RENDER_LIMIT, TRANSCRIPT_WINDOW_SIZE, shouldWindowTranscript, transcriptWindow } from "./transcript-window.js";

const state = {
  capabilities: undefined,
  semanticTraces: undefined,
  semanticTitles: undefined,
  semanticParents: undefined,
  forestCapability: undefined,
  organizerCapability: undefined,
  environment: undefined,
  organizeJob: undefined,
  organizePoll: undefined,
  sessionView: "list",
  forest: undefined,
  forestScopeId: undefined,
  forestScale: 1,
  forestLoading: false,
  expandedForestSessions: new Set(),
  forestTurnCache: new Map(),
  scopes: [],
  selectedScopeId: undefined,
  sessions: [],
  visibleSessions: [],
  sessionCursor: undefined,
  selectedSession: undefined,
  selectedTurnId: undefined,
  turns: [],
  turnCursor: undefined,
  liveEvents: undefined,
  reconcilingLiveUpdate: false,
  userNavigationInFlight: false,
  pendingLiveUpdate: false,
  navigationSequence: 0,
  turnWindowStart: 0,
  expandedToolTurns: new Set(),
  routeIssue: undefined,
  batchGeneration: undefined,
  batchSummary: undefined,
  userOverrides: undefined,
  lastManualEdit: undefined,
  undoBusy: false,
};

const elements = Object.fromEntries([
  "connection-state", "scope-count", "scope-list", "session-count", "session-list",
  "session-filter", "show-hidden", "more-sessions", "transcript-heading", "session-meta",
  "copy-session-id", "generate-session-traces", "batch-trace-progress", "route-notice", "navigation-notice", "semantic-preview-notice", "transcript-empty", "turn-list", "more-turns",
  "semantic-title-panel", "semantic-parent-panel",
  "session-list-view", "session-forest-view", "forest-surface", "forest-summary", "forest-viewport", "forest-canvas",
  "forest-zoom-out", "forest-fit", "forest-zoom-in", "organize-workspace", "cancel-organize", "organize-progress",
  "environment-version", "environment-history", "environment-store", "environment-ollama", "environment-model",
  "turn-window-controls", "previous-turn-window", "turn-window-status", "next-turn-window",
  "refresh-button", "map-v2-link", "diagnostics-button", "diagnostics-dialog", "close-diagnostics",
  "diagnostic-environment", "diagnostic-counts", "diagnostic-list", "toast",
].map((id) => [id, document.getElementById(id)]));

elements["session-filter"].addEventListener("input", () => {
  const startedAt = performance.now();
  renderSessions();
  renderForest();
  recordInteractionPerformance("session_filter", startedAt, { loadedSessions: state.sessions.length });
});
elements["show-hidden"].addEventListener("change", () => navigate(currentTarget(), { history: "replace" }));
elements["more-sessions"].addEventListener("click", () => loadSessions(false));
elements["more-turns"].addEventListener("click", () => loadTurns(false));
elements["previous-turn-window"].addEventListener("click", () => shiftTurnWindow(-TRANSCRIPT_WINDOW_SIZE));
elements["next-turn-window"].addEventListener("click", () => shiftTurnWindow(TRANSCRIPT_WINDOW_SIZE));
elements["refresh-button"].addEventListener("click", refreshSnapshot);
elements["copy-session-id"].addEventListener("click", copySessionId);
elements["generate-session-traces"].addEventListener("click", generateSessionTraces);
elements["diagnostics-button"].addEventListener("click", showDiagnostics);
elements["session-list-view"].addEventListener("click", () => setSessionView("list"));
elements["session-forest-view"].addEventListener("click", () => void setSessionView("forest"));
elements["forest-zoom-out"].addEventListener("click", () => setForestScale(state.forestScale - 0.1));
elements["forest-zoom-in"].addEventListener("click", () => setForestScale(state.forestScale + 0.1));
elements["forest-fit"].addEventListener("click", fitForestToView);
elements["organize-workspace"].addEventListener("click", () => void startWorkspaceOrganization());
elements["cancel-organize"].addEventListener("click", () => void cancelWorkspaceOrganization());
installForestPan();
elements["close-diagnostics"].addEventListener("click", () => elements["diagnostics-dialog"].close());
window.addEventListener("popstate", () => {
  const parsed = parseNavigationPath(window.location.pathname);
  void navigate(parsed.target, { history: "none", issue: parsed.issue });
});
window.addEventListener("keydown", (event) => {
  const target = event.target;
  if ((!event.ctrlKey && !event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "z") return;
  if (target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return;
  if (!state.userOverrides?.available) return;
  event.preventDefault();
  void undoManualChange();
});

initialize();

async function initialize() {
  setBusy(true, "Loading local history…");
  try {
    const bootstrap = await api("/api/bootstrap");
    state.capabilities = bootstrap.capabilities;
    state.scopes = bootstrap.scopes;
    const parsed = parseNavigationPath(window.location.pathname);
    await navigate(parsed.target, { history: "replace", issue: parsed.issue, bootstrap });
    connectLiveUpdates();
    setBusy(false, readyLabel());
  } catch (error) {
    setBusy(false, "Adapter unavailable");
    showToast(error.message);
  }
}

function connectLiveUpdates() {
  if (!state.capabilities?.liveUpdates || state.liveEvents) return;
  const events = new EventSource("/api/events");
  events.addEventListener("snapshot", () => void reconcileLiveUpdate());
  events.addEventListener("open", () => setBusy(false, readyLabel()));
  events.addEventListener("error", () => setBusy(true, "Live updates reconnecting…"));
  state.liveEvents = events;
}

async function reconcileLiveUpdate() {
  if (state.userNavigationInFlight) {
    state.pendingLiveUpdate = true;
    return;
  }
  if (state.reconcilingLiveUpdate) return;
  state.reconcilingLiveUpdate = true;
  const target = currentTarget();
  const scrollTop = elements["turn-list"].scrollTop;
  const forestScroll = { left: elements["forest-viewport"].scrollLeft, top: elements["forest-viewport"].scrollTop };
  try {
    const bootstrap = await api("/api/bootstrap");
    await navigate(target, { history: "none", bootstrap, preserveScroll: scrollTop, issue: state.routeIssue, background: true });
    if (state.sessionView === "forest") {
      await loadForest(true);
      elements["forest-viewport"].scrollTo(forestScroll);
    }
    setBusy(false, readyLabel());
    showToast("Codex history updated");
  } catch (error) {
    setBusy(false, "Live reconciliation failed");
    showToast(error.message);
  } finally {
    state.reconcilingLiveUpdate = false;
  }
}

async function navigate(requested, options = {}) {
  if (options.background && state.userNavigationInFlight) {
    state.pendingLiveUpdate = true;
    return;
  }
  if (!options.background) state.userNavigationInFlight = true;
  const sequence = ++state.navigationSequence;
  const navigationStartedAt = performance.now();
  setBusy(true, "Restoring navigation…");
  try {
    const bootstrap = options.bootstrap ?? await api("/api/bootstrap");
    const snapshot = await loadNavigationSnapshot(bootstrap, requested, options.issue);
    const loadMs = performance.now() - navigationStartedAt;
    if (sequence !== state.navigationSequence) return;
    const renderStartedAt = performance.now();
    applyNavigationSnapshot(snapshot, options.history ?? "push", options.preserveScroll);
    const renderMs = performance.now() - renderStartedAt;
    recordNavigationPerformance({
      name: "navigation",
      loadMs,
      renderMs,
      totalMs: performance.now() - navigationStartedAt,
      sessions: snapshot.sessions.length,
      turns: snapshot.turns.length,
      tools: snapshot.turns.reduce((sum, turn) => sum + turn.tools.length, 0),
      estimatedContentChars: estimateContentChars(snapshot.turns),
      depth: snapshot.target.turnId ? "turn" : snapshot.target.sessionId ? "session" : "workspace",
    });
    setBusy(false, readyLabel());
  } catch (error) {
    if (sequence !== state.navigationSequence) return;
    setBusy(false, "Navigation restore failed");
    showRouteIssue("invalid_route");
    showToast(error.message);
  } finally {
    if (!options.background) {
      state.userNavigationInFlight = false;
      if (state.pendingLiveUpdate) {
        state.pendingLiveUpdate = false;
        queueMicrotask(() => void reconcileLiveUpdate());
      }
    }
  }
}

async function loadNavigationSnapshot(bootstrap, requested, initialIssue) {
  const scopeIds = bootstrap.scopes.map((scope) => scope.id);
  const requestedScopeExists = scopeIds.includes(requested.scopeId);
  const scopeId = requestedScopeExists ? requested.scopeId : scopeIds[0];
  if (!scopeId) return { bootstrap, target: {}, issue: initialIssue ?? (requested.scopeId ? "workspace_missing" : undefined), sessions: [], turns: [] };

  const sessions = [];
  let sessionCursor;
  const requestedSessionId = requestedScopeExists ? requested.sessionId : undefined;
  do {
    const page = await fetchSessionsPage(scopeId, sessionCursor);
    sessions.push(...page.data);
    sessionCursor = page.nextCursor;
  } while (requestedSessionId && !sessions.some((session) => session.providerSessionId === requestedSessionId) && sessionCursor);
  let selectedSession = sessions.find((session) => session.providerSessionId === requestedSessionId);

  const turns = [];
  let turnCursor;
  if (selectedSession) do {
    const query = turnCursor ? `?cursor=${encodeURIComponent(turnCursor)}` : "";
    const page = await api(`/api/sessions/${encodeURIComponent(selectedSession.providerSessionId)}/turns${query}`);
    turns.push(...page.data);
    turnCursor = page.nextCursor;
  } while (requested.turnId && !turns.some((turn) => turn.id === requested.turnId) && turnCursor);

  if (selectedSession && bootstrap.semanticTitles?.available) {
    const result = await api(`/api/sessions/${encodeURIComponent(selectedSession.providerSessionId)}/semantic-title`);
    selectedSession = {
      ...selectedSession,
      displayTitle: result.semanticTitle.displayTitle,
      semanticTitle: result.semanticTitle,
    };
    const index = sessions.findIndex((session) => session.providerSessionId === selectedSession.providerSessionId);
    if (index >= 0) sessions[index] = selectedSession;
  }
  if (selectedSession && bootstrap.semanticParents?.available) {
    const result = await api(`/api/sessions/${encodeURIComponent(selectedSession.providerSessionId)}/semantic-parent`);
    selectedSession = { ...selectedSession, semanticParent: result.semanticParent };
    const index = sessions.findIndex((session) => session.providerSessionId === selectedSession.providerSessionId);
    if (index >= 0) sessions[index] = selectedSession;
  }

  const resolved = resolveNavigationAvailability(
    { scopeId: requested.scopeId ?? scopeId, sessionId: requestedSessionId, turnId: requested.turnId },
    { scopeIds, sessionIds: sessions.map((session) => session.providerSessionId), turnIds: turns.map((turn) => turn.id) },
  );
  return {
    bootstrap,
    target: resolved.target,
    issue: initialIssue ?? resolved.issue,
    sessions,
    sessionCursor,
    selectedSession: sessions.find((session) => session.providerSessionId === resolved.target.sessionId),
    turns,
    turnCursor,
  };
}

function applyNavigationSnapshot(snapshot, historyMode, preserveScroll) {
  const previousSessionId = state.selectedSession?.providerSessionId;
  const previousScopeId = state.selectedScopeId;
  state.capabilities = snapshot.bootstrap.capabilities;
  state.semanticTraces = snapshot.bootstrap.semanticTraces;
  state.userOverrides = snapshot.bootstrap.userOverrides;
  if (state.userOverrides?.available && !document.getElementById("undo-manual-change")) {
    const undo = create("button", "button secondary", { id: "undo-manual-change", type: "button" }, "Undo");
    undo.addEventListener("click", () => void undoManualChange());
    elements["refresh-button"].parentElement.append(undo);
  }
  state.semanticTitles = snapshot.bootstrap.semanticTitles;
  state.semanticParents = snapshot.bootstrap.semanticParents;
  state.forestCapability = snapshot.bootstrap.forest;
  state.organizerCapability = snapshot.bootstrap.organizer;
  state.environment = snapshot.bootstrap.environment;
  state.scopes = snapshot.bootstrap.scopes;
  state.selectedScopeId = snapshot.target.scopeId;
  state.sessions = snapshot.sessions;
  state.sessionCursor = snapshot.sessionCursor;
  state.selectedSession = snapshot.selectedSession;
  state.selectedTurnId = snapshot.target.turnId;
  const mapUrl = new URL("/map-v2", window.location.origin);
  if (snapshot.target.scopeId) mapUrl.searchParams.set("workspace", snapshot.target.scopeId);
  if (snapshot.target.sessionId) mapUrl.searchParams.set("session", snapshot.target.sessionId);
  if (snapshot.target.turnId) mapUrl.searchParams.set("turn", snapshot.target.turnId);
  elements["map-v2-link"].href = `${mapUrl.pathname}${mapUrl.search}`;
  state.turns = snapshot.turns;
  state.turnCursor = snapshot.turnCursor;
  if (previousScopeId !== snapshot.target.scopeId) {
    state.forest = undefined;
    state.forestScopeId = undefined;
    state.expandedForestSessions.clear();
    state.forestTurnCache.clear();
  }
  if (previousSessionId !== snapshot.selectedSession?.providerSessionId) {
    state.turnWindowStart = 0;
    state.expandedToolTurns.clear();
  }
  renderScopes();
  renderEnvironmentStatus();
  renderSessions();
  renderSessionSurface();
  renderForest();
  renderTranscript();
  showRouteIssue(snapshot.issue);
  const path = buildNavigationPath(snapshot.target);
  if (historyMode === "push" && path !== window.location.pathname) history.pushState({}, "", path);
  else if (historyMode === "replace" || (historyMode === "none" && snapshot.issue)) history.replaceState({}, "", path);
  if (preserveScroll !== undefined && snapshot.target.turnId) elements["turn-list"].scrollTop = preserveScroll;
  else focusSelectedTurn();
}

function currentTarget() {
  return {
    scopeId: state.selectedScopeId,
    sessionId: state.selectedSession?.providerSessionId,
    turnId: state.selectedTurnId,
  };
}

async function selectScope(scopeId) {
  await navigate({ scopeId }, { history: "push" });
}

async function loadSessions(reset) {
  if (!state.selectedScopeId) return;
  if (reset) {
    state.sessions = [];
    state.sessionCursor = undefined;
    state.selectedSession = undefined;
    state.turns = [];
    renderTranscript();
  }
  elements["more-sessions"].disabled = true;
  try {
    const page = await fetchSessionsPage(state.selectedScopeId, state.sessionCursor);
    state.sessions.push(...page.data);
    state.sessionCursor = page.nextCursor;
    renderSessions();
  } catch (error) { showToast(error.message); }
  finally { elements["more-sessions"].disabled = false; }
}

function fetchSessionsPage(scopeId, cursor) {
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  if (elements["show-hidden"].checked) query.set("includeHidden", "1");
  return api(`/api/scopes/${encodeURIComponent(scopeId)}/sessions?${query}`);
}

async function selectSession(session) {
  await navigate({ scopeId: state.selectedScopeId, sessionId: session.providerSessionId }, { history: "push" });
}

async function loadTurns(reset) {
  if (!state.selectedSession) return;
  if (reset) { state.turns = []; state.turnCursor = undefined; state.selectedTurnId = undefined; }
  const scrollTop = elements["turn-list"].scrollTop;
  elements["more-turns"].disabled = true;
  try {
    const query = state.turnCursor ? `?cursor=${encodeURIComponent(state.turnCursor)}` : "";
    const page = await api(`/api/sessions/${encodeURIComponent(state.selectedSession.providerSessionId)}/turns${query}`);
    state.turns.push(...page.data);
    state.turnCursor = page.nextCursor;
    renderTranscript();
    elements["turn-list"].scrollTop = scrollTop;
  } catch (error) { showToast(error.message); }
  finally { elements["more-turns"].disabled = false; }
}

function renderScopes() {
  elements["scope-count"].textContent = String(state.scopes.length);
  elements["scope-list"].replaceChildren(...state.scopes.map((scope) => {
    const button = create("button", "list-item", { type: "button", role: "listitem" });
    if (scope.id === state.selectedScopeId) button.classList.add("selected");
    button.append(
      create("span", "item-title", {}, scope.displayName),
      create("span", "item-subtitle", {}, scope.canonicalRoot ?? scope.source.replaceAll("_", " ")),
    );
    const badges = create("span", "item-badges");
    badges.append(badge(scope.source.replaceAll("_", " ")), badge(scope.health.state, scope.health.state));
    button.append(badges);
    button.addEventListener("click", () => selectScope(scope.id));
    return button;
  }));
}

function renderSessions() {
  const query = elements["session-filter"].value.trim().toLocaleLowerCase();
  state.visibleSessions = query ? state.sessions.filter((session) => `${session.displayTitle ?? session.title} ${session.title}`.toLocaleLowerCase().includes(query)) : [...state.sessions];
  elements["session-count"].textContent = String(state.visibleSessions.length);
  elements["session-list"].replaceChildren(...state.visibleSessions.map((session) => {
    const button = create("button", "list-item", { type: "button", role: "listitem" });
    if (state.selectedSession?.providerSessionId === session.providerSessionId) button.classList.add("selected");
    button.append(
      create("span", "item-title", {}, session.displayTitle ?? session.title),
      create("span", "item-subtitle", {}, formatDate(session.updatedAt) || "Update time unavailable"),
    );
    const badges = create("span", "item-badges");
    badges.append(badge(session.archiveStatus, session.archiveStatus));
    if (session.semanticTitle?.userTitle) badges.append(badge("user title", "user-edited"));
    else if (session.semanticTitle?.generatedTitle) badges.append(badge("semantic", "current"));
    if (session.sourceKind !== "interactive") badges.append(badge(session.sourceKind));
    if (session.health.state !== "complete") badges.append(badge(session.health.state, session.health.state));
    button.append(badges);
    button.addEventListener("click", () => selectSession(session));
    return button;
  }));
  elements["more-sessions"].hidden = state.sessionView === "forest" || !state.sessionCursor;
}

async function setSessionView(view) {
  state.sessionView = view;
  renderSessionSurface();
  if (view === "forest") await loadForest(false);
}

function renderSessionSurface() {
  const forest = state.sessionView === "forest";
  elements["session-list-view"].classList.toggle("active", !forest);
  elements["session-forest-view"].classList.toggle("active", forest);
  elements["session-list"].hidden = forest;
  elements["more-sessions"].hidden = forest || !state.sessionCursor;
  elements["forest-surface"].hidden = !forest;
  document.body.classList.toggle("forest-mode", forest);
  renderOrganizationState();
}

function renderEnvironmentStatus() {
  const environment = state.environment;
  if (!environment) return;
  elements["environment-version"].textContent = `v${environment.version}`;
  const historyReady = state.scopes.length > 0;
  elements["environment-history"].textContent = `Codex history · ${historyReady ? "Ready" : "Not found"}`;
  elements["environment-history"].className = historyReady ? "ready" : "unavailable";
  elements["environment-store"].textContent = `Semantic store · ${environment.semanticStore.available ? "Ready" : "Unavailable"}`;
  elements["environment-store"].className = environment.semanticStore.available ? "ready" : "unavailable";
  elements["environment-ollama"].textContent = `Ollama · ${environment.ollama.available ? "Ready" : "Unavailable"}`;
  elements["environment-ollama"].className = environment.ollama.available ? "ready" : "unavailable";
  elements["environment-model"].textContent = `${environment.ollama.model} · ${environment.ollama.available ? "Ready" : "Unavailable"}`;
  elements["environment-model"].className = environment.ollama.available ? "ready" : "unavailable";
}

async function loadForest(force) {
  if (state.sessionView !== "forest" || !state.selectedScopeId || !state.forestCapability?.available || state.forestLoading) return;
  if (!force && state.forest && state.forestScopeId === state.selectedScopeId) {
    renderForest();
    return;
  }
  state.forestLoading = true;
  elements["forest-summary"].textContent = "Materializing existing semantic data…";
  try {
    const result = await api(`/api/scopes/${encodeURIComponent(state.selectedScopeId)}/forest`);
    state.forest = result.forest;
    state.forestScopeId = state.selectedScopeId;
    renderForest();
  } catch (error) {
    elements["forest-summary"].textContent = "Forest unavailable";
    showToast(error.message);
  } finally { state.forestLoading = false; }
}

async function startWorkspaceOrganization() {
  if (!state.selectedScopeId || state.organizeJob?.status === "running") return;
  try {
    const result = await api(`/api/scopes/${encodeURIComponent(state.selectedScopeId)}/organize`, { method: "POST" });
    state.organizeJob = result.job;
    renderOrganizationState();
    scheduleOrganizationPoll();
  } catch (error) { showToast(error.message); }
}

async function cancelWorkspaceOrganization() {
  if (!state.organizeJob || state.organizeJob.status !== "running") return;
  try {
    const result = await api(`/api/organize/${encodeURIComponent(state.organizeJob.id)}/cancel`, { method: "POST" });
    state.organizeJob = result.job;
    renderOrganizationState();
  } catch (error) { showToast(error.message); }
}

function scheduleOrganizationPoll() {
  clearTimeout(state.organizePoll);
  if (!state.organizeJob || state.organizeJob.status !== "running") return;
  state.organizePoll = setTimeout(() => void pollWorkspaceOrganization(), 500);
}

async function pollWorkspaceOrganization() {
  if (!state.organizeJob) return;
  try {
    const result = await api(`/api/organize/${encodeURIComponent(state.organizeJob.id)}`);
    const previousStatus = state.organizeJob.status;
    state.organizeJob = result.job;
    renderOrganizationState();
    if (result.job.status === "running") return scheduleOrganizationPoll();
    if (previousStatus === "running") await finishWorkspaceOrganization(result.job);
  } catch (error) {
    showToast(error.message);
    scheduleOrganizationPoll();
  }
}

async function finishWorkspaceOrganization(job) {
  if (job.scopeId === state.selectedScopeId) {
    await navigate(currentTarget(), { history: "none" });
    await loadForest(true);
  }
  const result = job.result;
  const message = job.status === "completed"
    ? `Workspace organized · ${result?.titlesGenerated ?? 0} titles · ${result?.relationshipsGenerated ?? 0} relationships · ${result?.warnings ?? 0} warnings`
    : job.status === "cancelled" ? "Workspace organization cancelled" : `Workspace organization failed: ${job.error ?? "unknown error"}`;
  showToast(message);
}

function renderOrganizationState() {
  const available = Boolean(state.organizerCapability?.available);
  const running = state.organizeJob?.status === "running";
  elements["organize-workspace"].hidden = !available;
  elements["organize-workspace"].disabled = running || !state.selectedScopeId;
  elements["organize-workspace"].textContent = running ? "Organizing Workspace…" : "Organize Workspace";
  elements["cancel-organize"].hidden = !running;
  const progress = state.organizeJob?.progress;
  if (!progress) {
    elements["organize-progress"].hidden = true;
    return;
  }
  const phase = progress.phase === "titles" ? "Titles" : progress.phase === "relationships" ? "Relationships" : progress.phase;
  elements["organize-progress"].textContent = `${phase} · Titles ${progress.titlesProcessed}/${progress.sessions} · Relationships ${progress.relationshipsProcessed}/${progress.sessions} · Warnings ${progress.warnings}`;
  elements["organize-progress"].hidden = false;
}

function renderForest() {
  if (state.sessionView !== "forest") return;
  const canvas = elements["forest-canvas"];
  if (!state.forest) {
    canvas.replaceChildren(create("p", "forest-empty", {}, state.forestCapability?.available ? "Choose Forest to materialize existing data." : "Forest projection is unavailable."));
    return;
  }
  const stats = state.forest.stats;
  elements["forest-summary"].textContent = `${stats.sessions} Sessions · ${stats.confirmedRoots} confirmed roots · ${stats.semanticEdges} edges · ${stats.unorganized} unorganized · ${stats.missingTitles} missing titles`;
  const query = elements["session-filter"].value.trim().toLocaleLowerCase();
  const sections = [];
  if (state.forest.roots.length) sections.push(renderForestSection("Organized Forest", state.forest.roots, query));
  if (state.forest.unorganized.length) sections.push(renderForestSection(`Unorganized (${stats.unorganized})`, state.forest.unorganized, query, "unorganized"));
  if (!sections.length) sections.push(create("p", "forest-empty", {}, "No Sessions in this Workspace."));
  canvas.replaceChildren(...sections);
  setForestScale(state.forestScale);
  if (query) requestAnimationFrame(() => canvas.querySelector(".forest-node.search-match")?.scrollIntoView({ block: "center", inline: "center" }));
}

function renderForestSection(title, nodes, query, modifier = "") {
  const section = create("section", `forest-section ${modifier}`.trim());
  section.append(create("h3", "forest-section-title", {}, title));
  const body = create("div", "forest-section-body");
  body.append(...nodes.map((root) => renderForestBranch(root, query, 0)));
  section.append(body);
  return section;
}

function renderForestBranch(node, query, depth) {
  const branch = create("div", `forest-branch depth-${Math.min(depth, 8)}`);
  const card = create("article", "forest-node");
  card.dataset.sessionId = node.sessionId;
  if (node.sessionId === state.selectedSession?.providerSessionId) card.classList.add("selected");
  if (query && `${node.displayTitle} ${node.originalTitle}`.toLocaleLowerCase().includes(query)) card.classList.add("search-match");
  const select = create("button", "forest-node-main", { type: "button" });
  select.append(create("strong", "forest-node-title", {}, node.displayTitle));
  const meta = create("span", "forest-node-meta");
  meta.append(badge(node.semanticRelation, node.semanticRelation), badge(node.placementSource === "none" ? "unplaced" : node.placementSource, node.placementSource));
  if (node.nativeLineage) meta.append(badge("native origin", "native"));
  const cached = state.forestTurnCache.get(node.sessionId);
  const traceCount = cached && !cached.loading && !cached.error ? cached.turns.filter((turn) => turn.semanticTrace?.displayText).length : node.traceCount;
  meta.append(create("span", "forest-turn-count", {}, `${node.turnCount} Turns · ${traceCount} Traces`));
  select.append(meta);
  select.addEventListener("click", () => void selectForestSession(node.sessionId));
  card.append(select);
  const actions = create("div", "forest-node-actions");
  const traces = create("button", "forest-node-action", { type: "button" }, state.expandedForestSessions.has(node.sessionId) ? "Hide traces" : "Show traces");
  traces.addEventListener("click", () => void toggleForestTraces(node.sessionId));
  const edit = create("button", "forest-node-action", { type: "button" }, "Edit title");
  edit.addEventListener("click", () => void editForestTitle(node.sessionId));
  const move = create("button", "forest-node-action", { type: "button" }, "Move");
  move.addEventListener("click", () => void moveForestNode(node.sessionId));
  actions.append(traces, edit, move);
  card.append(actions);
  if (state.expandedForestSessions.has(node.sessionId)) card.append(renderForestTraces(node.sessionId));
  branch.append(card);
  if (node.children.length) {
    const children = create("div", "forest-children");
    children.append(...node.children.map((child) => renderForestBranch(child, query, depth + 1)));
    branch.append(children);
  }
  return branch;
}

async function selectForestSession(sessionId, turnId) {
  await navigate({ scopeId: state.selectedScopeId, sessionId, turnId }, { history: "push" });
  renderForest();
}

async function toggleForestTraces(sessionId) {
  if (state.expandedForestSessions.has(sessionId)) state.expandedForestSessions.delete(sessionId);
  else {
    state.expandedForestSessions.add(sessionId);
    if (!state.forestTurnCache.has(sessionId)) {
      const pending = { loading: true, turns: [], updates: new Map() };
      state.forestTurnCache.set(sessionId, pending);
      renderForest();
      try {
        const turns = await loadAllForestTurns(sessionId);
        for (const turn of turns) if (pending.updates.has(turn.id)) turn.semanticTrace = pending.updates.get(turn.id);
        if (state.forestTurnCache.get(sessionId) === pending) state.forestTurnCache.set(sessionId, { loading: false, turns });
      } catch (error) {
        if (state.forestTurnCache.get(sessionId) === pending) state.forestTurnCache.set(sessionId, { loading: false, turns: [], error: error.message });
      }
    }
  }
  renderForest();
}

async function loadAllForestTurns(sessionId) {
  const turns = [];
  let cursor;
  const seen = new Set();
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await api(`/api/sessions/${encodeURIComponent(sessionId)}/turns${query}`);
    turns.push(...page.data);
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return turns;
}

function renderForestTraces(sessionId) {
  const container = create("div", "forest-traces");
  const cached = state.forestTurnCache.get(sessionId);
  const branch = state.forest?.branches?.find((item) => item.sessionId === sessionId);
  if (!cached || cached.loading) {
    container.append(create("p", "forest-trace-missing", {}, "Loading Turn traces…"));
    return container;
  }
  if (cached.error) {
    container.append(create("p", "forest-trace-missing", {}, cached.error));
    return container;
  }
  if (!cached.turns.length) {
    container.append(create("p", "forest-trace-missing", {}, "No Turns available."));
    return container;
  }
  const traced = cached.turns.filter((turn) => Boolean(turn.semanticTrace?.displayText));
  const summary = traced.length
    ? `${traced.length} / ${cached.turns.length} semantic traces`
    : `${cached.turns.length} Turns · No semantic traces yet`;
  container.append(create("p", "forest-trace-summary", {}, summary));
  if (traced.length < cached.turns.length && state.semanticTraces?.generationAvailable) {
    const running = state.batchGeneration?.sessionId === sessionId;
    const generate = create("button", "forest-node-action", { type: "button" }, running ? "Generating traces…" : traced.length ? "Generate missing traces" : "Generate traces");
    generate.disabled = Boolean(state.batchGeneration);
    generate.addEventListener("click", async () => {
      await selectForestSession(sessionId);
      await generateSessionTraces();
    });
    container.append(generate);
  }
  container.append(...cached.turns.map((turn) => {
    const item = create("button", "forest-trace-item", { type: "button" });
    item.append(create("span", "forest-trace-ordinal", {}, `T${turn.ordinal}`));
    const content = create("span", "forest-trace-content");
    content.append(create("span", "forest-trace-text", {}, turn.semanticTrace?.navigationLabel ?? turn.semanticTrace?.displayText ?? (turn.input?.replace(/\s+/g, " ").trim().slice(0, 120) || `第 ${turn.ordinal} 轮`)));
    const attachments = branch?.turns?.find((item) => item.nativeTurnId === turn.id)?.childSessions ?? [];
    if (attachments.length) {
      const children = create("span", "forest-turn-branches");
      for (const child of attachments) {
        const provenance = child.source === "native" ? "Native fork" : `${child.source === "user" ? "User" : "AI"} · ${child.relation}`;
        children.append(create("span", "forest-turn-branch", {}, `↳ ${child.childTitle} · ${provenance}`));
      }
      content.append(children);
    }
    item.append(content);
    item.addEventListener("click", () => void selectForestSession(sessionId, turn.id));
    return item;
  }));
  if (branch?.sessionLevelChildren?.length) {
    const children = create("div", "forest-session-branches");
    children.append(create("span", "forest-trace-ordinal", {}, "SESSION"));
    children.append(create("span", "forest-trace-text", {}, branch.sessionLevelChildren.map((child) => `↳ ${child.childTitle} · ${child.source === "user" ? "User" : "AI"} · ${child.relation}`).join("\n")));
    container.append(children);
  }
  for (const child of branch?.unavailableAnchors ?? []) {
    container.append(create("p", "forest-anchor-unavailable", {}, `Turn anchor unavailable · ${child.childTitle} (${child.anchorTurnId})`));
  }
  return container;
}

function refreshForestTraces(sessionId) {
  const cached = state.forestTurnCache.get(sessionId);
  for (const card of elements["forest-canvas"].querySelectorAll(".forest-node")) {
    if (card.dataset.sessionId !== sessionId) continue;
    if (cached && !cached.loading && !cached.error) {
      card.querySelector(".forest-turn-count").textContent = `${cached.turns.length} Turns · ${cached.turns.filter((turn) => turn.semanticTrace?.displayText).length} Traces`;
    }
    const previous = card.querySelector(".forest-traces");
    if (previous) {
      const scrollTop = previous.scrollTop;
      const next = renderForestTraces(sessionId);
      previous.replaceWith(next);
      next.scrollTop = scrollTop;
    }
  }
}

function applyGeneratedTrace(sessionId, turnId, semanticTrace) {
  const cached = state.forestTurnCache.get(sessionId);
  if (cached?.loading) cached.updates.set(turnId, semanticTrace);
  const cachedTurn = cached?.turns.find((turn) => turn.id === turnId);
  if (cachedTurn) cachedTurn.semanticTrace = semanticTrace;
  refreshForestTraces(sessionId);
  if (state.selectedSession?.providerSessionId === sessionId) {
    const turn = state.turns.find((turn) => turn.id === turnId);
    if (turn) turn.semanticTrace = semanticTrace;
    const scrollTop = elements["turn-list"].scrollTop;
    renderTranscript();
    elements["turn-list"].scrollTop = scrollTop;
  }
}

async function editForestTitle(sessionId) {
  await selectForestSession(sessionId);
  const session = state.selectedSession;
  if (!session || !state.userOverrides?.available) return showToast("User override storage is unavailable.");
  void showSemanticTitleEditor(session, session.semanticTitle ?? {}, elements["semantic-title-panel"]);
  elements["semantic-title-panel"].scrollIntoView({ block: "nearest" });
}

async function moveForestNode(sessionId) {
  await selectForestSession(sessionId);
  const session = state.selectedSession;
  if (!session || !state.userOverrides?.available) return showToast("User override storage is unavailable.");
  showSemanticParentEditor(session, session.semanticParent, elements["semantic-parent-panel"]);
  elements["semantic-parent-panel"].scrollIntoView({ block: "nearest" });
}

function setForestScale(value) {
  state.forestScale = Math.max(0.55, Math.min(1.4, Math.round(value * 10) / 10));
  elements["forest-canvas"].style.zoom = String(state.forestScale);
}

function fitForestToView() {
  const viewport = elements["forest-viewport"];
  const canvas = elements["forest-canvas"];
  canvas.style.zoom = "1";
  const scale = Math.min(1, (viewport.clientWidth - 24) / Math.max(canvas.scrollWidth, 1));
  setForestScale(scale);
  viewport.scrollTo({ left: 0, top: 0, behavior: "smooth" });
}

function installForestPan() {
  const viewport = elements["forest-viewport"];
  let drag;
  viewport.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, input, select")) return;
    drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("panning");
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!drag) return;
    viewport.scrollLeft = drag.left - (event.clientX - drag.x);
    viewport.scrollTop = drag.top - (event.clientY - drag.y);
  });
  const finish = () => { drag = undefined; viewport.classList.remove("panning"); };
  viewport.addEventListener("pointerup", finish);
  viewport.addEventListener("pointercancel", finish);
}

function renderTranscript() {
  const session = state.selectedSession;
  elements["turn-list"].replaceChildren();
  elements["more-turns"].hidden = true;
  elements["turn-window-controls"].hidden = true;
  if (!session) {
    elements["transcript-heading"].textContent = "Select a session";
    elements["session-meta"].textContent = "Turns will appear here without modifying Codex.";
    elements["copy-session-id"].hidden = true;
    elements["generate-session-traces"].hidden = true;
    elements["batch-trace-progress"].hidden = true;
    elements["navigation-notice"].hidden = true;
    elements["semantic-preview-notice"].hidden = true;
    elements["semantic-title-panel"].hidden = true;
    elements["semantic-parent-panel"].hidden = true;
    elements["transcript-empty"].hidden = false;
    return;
  }
  elements["transcript-heading"].textContent = session.displayTitle ?? session.title;
  elements["session-meta"].textContent = `${session.archiveStatus} · updated ${formatDate(session.updatedAt) || "unknown"} · ${state.turns.length} loaded turns`;
  elements["copy-session-id"].hidden = false;
  renderSemanticSessionTitle(session);
  renderSemanticParent(session);
  renderBatchGenerationState(session.providerSessionId);
  elements["transcript-empty"].hidden = state.turns.length > 0;
  if (!state.capabilities?.openTurn) {
    elements["navigation-notice"].textContent = "Exact native Turn navigation is not available. This transcript is the supported read-only fallback.";
    elements["navigation-notice"].hidden = false;
  } else elements["navigation-notice"].hidden = true;
  elements["semantic-preview-notice"].textContent = state.semanticTraces?.available
    ? "Semantic traces are generated locally by AI for navigation. Check the original Turn when accuracy matters."
    : state.semanticTraces?.reason ?? "Semantic Trace preview is unavailable.";
  elements["semantic-preview-notice"].hidden = false;
  const toolCount = state.turns.reduce((sum, turn) => sum + turn.tools.length, 0);
  const windowRequired = shouldWindowTranscript({ turns: state.turns.length, tools: toolCount, contentChars: estimateContentChars(state.turns) });
  const window = windowRequired
    ? transcriptWindow(state.turns, state.selectedTurnId, state.turnWindowStart)
    : { data: state.turns, start: 0, end: state.turns.length, active: false };
  state.turnWindowStart = window.start;
  elements["turn-list"].replaceChildren(...window.data.map(renderTurn));
  elements["turn-window-controls"].hidden = !windowRequired;
  if (windowRequired) {
    elements["turn-window-status"].textContent = `Showing turns ${window.start + 1}–${window.end} of ${state.turns.length}`;
    elements["previous-turn-window"].disabled = window.start === 0;
    elements["next-turn-window"].disabled = window.end === state.turns.length;
  }
  elements["more-turns"].hidden = !state.turnCursor;
}

function renderSemanticSessionTitle(session) {
  const panel = elements["semantic-title-panel"];
  panel.replaceChildren();
  panel.hidden = false;
  const title = session.semanticTitle ?? {
    availability: state.semanticTitles?.available ? "available" : "unavailable",
    originalTitle: session.originalTitle ?? session.title,
    displayTitle: session.title,
    freshness: "missing",
  };
  const head = create("div", "semantic-title-head");
  const heading = create("div");
  heading.append(create("p", "semantic-title-label", {}, "Semantic Session Title"));
  if (title.freshness) heading.append(badge(title.freshness, title.freshness));
  if (title.userTitle) heading.append(badge("User edited", "user-edited"));
  head.append(heading);
  const actions = create("div", "semantic-title-actions");
  if (state.semanticTitles?.available) {
    if (state.semanticTitles.generationAvailable) {
    const generate = create("button", "button primary", { type: "button" }, title.generatedTitle ? "Regenerate title" : "Generate title");
    generate.addEventListener("click", () => void generateSemanticSessionTitle(session, generate));
    actions.append(generate);
    }
    if (state.userOverrides?.available) {
      const edit = create("button", "button secondary", { type: "button" }, "Rename");
      edit.addEventListener("click", () => showSemanticTitleEditor(session, title, panel));
      actions.append(edit);
      if (title.userTitle) actions.append(restoreAutomaticButton(session, "title"));
    }
  }
  head.append(actions);
  panel.append(head);
  const original = create("div", "semantic-title-row");
  original.append(create("span", "semantic-title-row-label", {}, "Original title"), create("p", "semantic-title-original", {}, title.originalTitle ?? session.title));
  panel.append(original);
  const semantic = create("div", "semantic-title-row");
  semantic.append(create("span", "semantic-title-row-label", {}, title.userTitle ? "Preferred user title" : "Semantic title"));
  semantic.append(create("p", title.userTitle || title.generatedTitle ? "semantic-title-value" : "semantic-title-placeholder", {}, title.displayTitle && (title.userTitle || title.generatedTitle)
    ? title.displayTitle
    : state.semanticTitles?.available ? "Not generated yet." : state.semanticTitles?.reason ?? "Semantic Session Title is unavailable."));
  panel.append(semantic);
  if (title.userTitle && title.generatedTitle) {
    const details = create("details", "semantic-title-original-ai");
    details.append(create("summary", "semantic-trace-original-summary", {}, "View AI title"), create("p", "semantic-trace-original-text", {}, title.generatedTitle));
    panel.append(details);
  }
  const metadata = [title.model, title.generatedAt ? `generated ${formatDate(title.generatedAt)}` : undefined].filter(Boolean).join(" · ");
  if (metadata) panel.append(create("p", "semantic-trace-meta", {}, metadata));
}

async function generateSemanticSessionTitle(session, button) {
  button.disabled = true;
  button.textContent = "Generating locally…";
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session.providerSessionId)}/semantic-title`, { method: "POST" });
    applySemanticTitleToSession(session.providerSessionId, result.semanticTitle);
    await loadForest(true);
    renderSessions();
    renderTranscript();
    showToast(result.semanticTitle.userTitle ? "AI title regenerated; user title preserved" : "Semantic Session Title generated");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Try again";
    showToast(error.message);
  }
}

async function showSemanticTitleEditor(session, title, panel) {
  let override;
  try { override = (await readManualOverride(session, "title")).override; }
  catch (error) { return showToast(error.message); }
  const editor = create("div", "semantic-title-editor");
  const input = create("input", "semantic-title-input", { type: "text", maxlength: "80", "aria-label": "Edited Semantic Session Title" });
  input.value = override.value?.title ?? title.generatedTitle ?? session.originalTitle ?? session.title;
  const save = create("button", "button primary", { type: "button" }, "Save title");
  const cancel = create("button", "button secondary", { type: "button" }, "Cancel");
  save.addEventListener("click", () => void saveSemanticSessionTitle(session, input.value, override.revision));
  cancel.addEventListener("click", () => renderSemanticSessionTitle(session));
  editor.append(input, save, cancel);
  panel.append(editor);
  input.focus();
}

async function saveSemanticSessionTitle(session, userTitle, revision) {
  try {
    const result = await writeManualOverride(session, "title", { title: userTitle }, revision);
    applySemanticTitleToSession(session.providerSessionId, result.semanticTitle);
    await loadForest(true);
    renderSessions();
    renderTranscript();
    showManualUndo("Session renamed", result.edit);
  } catch (error) { showToast(error.message); }
}

function applySemanticTitleToSession(sessionId, semanticTitle) {
  for (const session of state.sessions) {
    if (session.providerSessionId !== sessionId) continue;
    session.semanticTitle = semanticTitle;
    session.displayTitle = semanticTitle.displayTitle;
  }
  if (state.selectedSession?.providerSessionId === sessionId) {
    state.selectedSession.semanticTitle = semanticTitle;
    state.selectedSession.displayTitle = semanticTitle.displayTitle;
  }
  state.forest = undefined;
  state.forestScopeId = undefined;
}

function renderSemanticParent(session) {
  const panel = elements["semantic-parent-panel"];
  panel.replaceChildren();
  panel.hidden = false;
  const parent = session.semanticParent ?? { availability: state.semanticParents?.available ? "available" : "unavailable", freshness: "missing", candidates: [] };
  const head = create("div", "semantic-title-head");
  const heading = create("div");
  heading.append(create("p", "semantic-title-label", {}, "Semantic Relationship"));
  if (parent.freshness) heading.append(badge(parent.freshness, parent.freshness));
  if (parent.authority === "user") heading.append(badge("User reviewed", "user-edited"));
  head.append(heading);
  const actions = create("div", "semantic-title-actions");
  if (state.semanticParents?.available) {
    if (state.semanticParents.generationAvailable) {
    const infer = create("button", "button primary", { type: "button" }, parent.generatedRelation ? "Regenerate" : "Infer parent");
    infer.addEventListener("click", () => void inferSemanticParent(session, infer));
    actions.append(infer);
    }
    if (parent.generatedRelation) {
      const accept = create("button", "button secondary", { type: "button" }, "Accept");
      accept.addEventListener("click", () => void reviewSemanticParent(session, parent.generatedRelation, parent.generatedParentSessionId));
      actions.append(accept);
    }
    if (state.userOverrides?.available) {
      const change = create("button", "button secondary", { type: "button" }, "Change parent");
      change.addEventListener("click", () => showSemanticParentEditor(session, parent, panel));
      const root = create("button", "button secondary", { type: "button" }, "Set root");
      root.addEventListener("click", () => void reviewSemanticParent(session, "root"));
      actions.append(change, root);
      if (parent.authority === "user") actions.append(restoreAutomaticButton(session, "parent"));
    }
  }
  head.append(actions);
  panel.append(head);
  const display = create("div", "semantic-title-row");
  display.append(create("span", "semantic-title-row-label", {}, "Semantic parent"));
  display.append(create("p", parent.relation ? "semantic-title-value" : "semantic-title-placeholder", {}, semanticParentLabel(parent)));
  panel.append(display);
  if (parent.generatedReason) panel.append(create("p", "semantic-parent-reason", {}, `AI reason: ${parent.generatedReason}`));
  if (parent.nativeLineage) {
    const native = parent.nativeLineage.parentSessionId
      ? `${parent.nativeLineage.parentSessionId}${parent.nativeLineage.originTurnId ? ` / ${parent.nativeLineage.originTurnId}` : ""} · ${parent.nativeLineage.kind} · ${parent.nativeLineage.recovery}`
      : `${parent.nativeLineage.kind} · ${parent.nativeLineage.recovery}`;
    panel.append(create("p", "semantic-parent-native", {}, `Native lineage (separate): ${native}`));
  }
  if (!state.semanticParents?.available) panel.append(create("p", "semantic-title-placeholder", {}, "Semantic Parent inference is unavailable."));
}

function semanticParentLabel(parent) {
  if (!parent.relation) return "Not inferred yet.";
  if (parent.relation === "root") return `ROOT · ${parent.authority === "user" ? "User selected" : "AI inferred"}`;
  const candidate = parent.candidates?.find((item) => item.sessionId === parent.parentSessionId);
  const anchor = parent.anchorTurnId ? ` · anchor ${parent.anchorTurnId}` : " · Session level";
  return `${candidate?.title ?? parent.parentSessionId}${anchor} · ${parent.relation} · ${parent.authority === "user" ? "User selected" : "AI inferred"}`;
}

async function inferSemanticParent(session, button) {
  button.disabled = true;
  button.textContent = "Inferring locally…";
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session.providerSessionId)}/semantic-parent`, { method: "POST" });
    applySemanticParentToSession(session.providerSessionId, result.semanticParent);
    await loadForest(true);
    renderTranscript();
    showToast(result.semanticParent.authority === "user" ? "AI relation regenerated; user correction preserved" : "Semantic Parent inferred");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Try again";
    showToast(error.message);
  }
}

async function showSemanticParentEditor(session, parent = {}, panel) {
  let override, candidates;
  try {
    const results = await Promise.all([readManualOverride(session, "parent"), api(`/api/sessions/${encodeURIComponent(session.providerSessionId)}/manual-parents`)]);
    override = results[0].override;
    candidates = results[1].candidates;
  } catch (error) { return showToast(error.message); }
  const editor = create("div", "semantic-parent-editor");
  const search = create("input", "semantic-title-input", { type: "search", placeholder: "Filter legal parent titles…", "aria-label": "Filter legal parent titles" });
  const select = create("select", "semantic-parent-select", { "aria-label": "Semantic Parent Session" });
  const anchor = create("select", "semantic-parent-select", { "aria-label": "Optional anchor Turn" });
  const suggested = new Set((parent.candidates ?? []).map((candidate) => candidate.sessionId));
  candidates.sort((a, b) => Number(suggested.has(b.sessionId)) - Number(suggested.has(a.sessionId)));
  const populate = () => {
  select.replaceChildren();
  for (const candidate of candidates.filter((item) => item.title.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()))) {
    const option = create("option", "", { value: candidate.sessionId }, `${suggested.has(candidate.sessionId) ? "Suggested · " : ""}${candidate.title}`);
    if (candidate.sessionId === parent.parentSessionId) option.selected = true;
    select.append(option);
  }
  };
  populate();
  const relation = create("select", "semantic-parent-select", { "aria-label": "Semantic relation" });
  for (const value of ["continuation", "subtask"]) {
    const option = create("option", "", { value }, value);
    if (value === parent.relation) option.selected = true;
    relation.append(option);
  }
  const save = create("button", "button primary", { type: "button" }, "Save relationship");
  const cancel = create("button", "button secondary", { type: "button" }, "Cancel");
  let anchorLoad = 0;
  const populateAnchors = async (parentSessionId, selectedAnchorId) => {
    const load = ++anchorLoad;
    anchor.disabled = true;
    anchor.replaceChildren(create("option", "", { value: "" }, parentSessionId ? "Loading Turns…" : "No Turn anchor (Session level)"));
    if (!parentSessionId) return;
    try {
      const turns = await loadTurnDirectory(parentSessionId);
      if (load !== anchorLoad) return;
      anchor.replaceChildren(create("option", "", { value: "" }, "No Turn anchor (Session level)"));
      for (const turn of turns) {
        const option = create("option", "", { value: turn.nativeTurnId }, `T${turn.displayOrdinal}  ${turn.displayLabel}`);
        if (turn.nativeTurnId === selectedAnchorId) option.selected = true;
        anchor.append(option);
      }
      if (selectedAnchorId && !turns.some((turn) => turn.nativeTurnId === selectedAnchorId)) {
        anchor.append(create("option", "", { value: selectedAnchorId, selected: "" }, `Turn anchor unavailable · ${selectedAnchorId}`));
      }
      anchor.disabled = false;
    } catch (error) {
      if (load !== anchorLoad) return;
      anchor.replaceChildren(create("option", "", { value: "" }, error.message));
    }
  };
  save.disabled = !select.value;
  search.addEventListener("input", () => { populate(); save.disabled = !select.value; void populateAnchors(select.value); });
  select.addEventListener("change", () => { save.disabled = !select.value; void populateAnchors(select.value); });
  save.addEventListener("click", () => void reviewSemanticParent(session, relation.value, select.value, override.revision, anchor.value || undefined));
  cancel.addEventListener("click", () => renderSemanticParent(session));
  editor.append(search, select, anchor, relation, save, cancel);
  panel.append(editor);
  await populateAnchors(select.value, parent.anchorTurnId ?? override.value?.anchorTurnId);
}

async function loadTurnDirectory(sessionId) {
  const turns = [];
  let cursor;
  const seen = new Set();
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await api(`/api/sessions/${encodeURIComponent(sessionId)}/turn-directory${query}`);
    turns.push(...page.data);
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return turns;
}

async function reviewSemanticParent(session, relation, parentSessionId, revision, anchorTurnId) {
  try {
    revision ??= (await readManualOverride(session, "parent")).override.revision;
    const result = await writeManualOverride(session, "parent", { relation, parentSessionId, anchorTurnId }, revision);
    applySemanticParentToSession(session.providerSessionId, result.semanticParent);
    await loadForest(true);
    renderTranscript();
    showManualUndo(relation === "root" ? "Session set as root" : "Session moved", result.edit);
  } catch (error) { showToast(error.message); }
}

function applySemanticParentToSession(sessionId, semanticParent) {
  for (const session of state.sessions) if (session.providerSessionId === sessionId) session.semanticParent = semanticParent;
  if (state.selectedSession?.providerSessionId === sessionId) state.selectedSession.semanticParent = semanticParent;
  state.forest = undefined;
  state.forestScopeId = undefined;
}

function renderTurn(turn) {
  const card = create("section", "turn-card");
  card.dataset.turnId = turn.id;
  card.tabIndex = 0;
  if (turn.id === state.selectedTurnId) card.classList.add("selected");
  card.addEventListener("click", () => selectTurn(turn.id));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectTurn(turn.id); }
  });
  const head = create("div", "turn-head");
  const left = create("div");
  left.append(create("span", "turn-number", {}, `TURN ${turn.ordinal}`), badge(turn.status, turn.status));
  head.append(left, create("time", "turn-time", {}, formatDate(turn.startedAt) || turn.initiator));
  card.append(head, renderSemanticTrace(turn));
  if (turn.input) card.append(message("Input", turn.input));
  if (turn.attachments?.length) card.append(message("Attachments", turn.attachments.map((item) => item.name ?? item.kind).join(", ")));
  if (turn.assistantFinal) card.append(message("Assistant", turn.assistantFinal, "assistant-message"));
  if (turn.tools?.length) {
    const tools = create("div", "tool-list");
    const expanded = state.expandedToolTurns.has(turn.id);
    const visibleTools = expanded ? turn.tools : turn.tools.slice(0, TOOL_RENDER_LIMIT);
    for (const tool of visibleTools) {
      const item = create("div", "tool-item");
      item.append(create("div", "tool-name", {}, `${tool.name} · ${tool.status}`));
      const summary = [tool.inputSummary, tool.outputSummary].filter(Boolean).join("\n");
      if (summary) item.append(create("p", "tool-summary", {}, summary));
      tools.append(item);
    }
    if (!expanded && turn.tools.length > visibleTools.length) {
      const expand = create("button", "tool-expand", { type: "button" }, `Show ${turn.tools.length - visibleTools.length} more tool items`);
      expand.addEventListener("click", (event) => {
        event.stopPropagation();
        const scrollTop = elements["turn-list"].scrollTop;
        state.expandedToolTurns.add(turn.id);
        renderTranscript();
        elements["turn-list"].scrollTop = scrollTop;
      });
      tools.append(expand);
    }
    card.append(tools);
  }
  if (!turn.input && !turn.assistantFinal && !turn.tools?.length) card.append(message("Turn", "No public message content was persisted for this turn."));
  return card;
}

function renderSemanticTrace(turn) {
  const value = turn.semanticTrace ?? { availability: "unavailable" };
  const wrapper = create("div", "semantic-trace");
  const head = create("div", "semantic-trace-head");
  head.append(create("span", "semantic-trace-label", {}, "Semantic Trace"));
  if (value.freshness) head.append(badge(value.freshness, value.freshness));
  if (value.safetyWarning) head.append(badge("safety warning", "safety-warning"));
  if (value.languageMismatch) head.append(badge("language mismatch", "partial"));
  if (value.userFeedback?.verdict) head.append(badge(value.userFeedback.verdict, value.userFeedback.verdict));
  if (value.userFeedback?.verdict === "edited") head.append(badge("User edited", "user-edited"));
  if (value.userFeedback?.basedOnStaleSource) head.append(badge("edited from stale source", "partial"));
  wrapper.append(head);
  if (value.userFeedback?.verdict === "rejected") wrapper.classList.add("rejected");

  const displayText = value.displayText ?? value.text;
  if (displayText) {
    wrapper.append(create("p", "semantic-trace-text", {}, displayText));
    const metadata = [value.model, value.generatedAt ? `generated ${formatDate(value.generatedAt)}` : undefined].filter(Boolean).join(" · ");
    if (metadata) wrapper.append(create("p", "semantic-trace-meta", {}, metadata));
    if (value.text && value.userFeedback?.verdict === "edited") wrapper.append(aiOriginalDetails(value));
  } else {
    wrapper.append(create("p", "semantic-trace-placeholder", {}, value.availability === "available"
      ? "No trace generated for this Turn."
      : "Local Semantic Trace generation is unavailable."));
  }

  if (value.availability === "available" && state.semanticTraces?.generationAvailable) {
    const action = create("button", "semantic-trace-action", { type: "button" }, value.freshness === "stale" ? "Regenerate trace" : value.text ? "Regenerate" : "Generate trace");
    action.addEventListener("click", async (event) => {
      event.stopPropagation();
      await generateSemanticTrace(turn, action);
    });
    wrapper.append(action);
  }
  if (value.text || state.userOverrides?.available) wrapper.append(renderTraceFeedback(turn, value));
  return wrapper;
}

function aiOriginalDetails(value) {
  const details = create("details", "semantic-trace-original");
  details.append(create("summary", "semantic-trace-original-summary", {}, "View AI original"));
  details.append(create("p", "semantic-trace-original-text", {}, value.reviewedAiOriginalText ?? value.aiOriginalText ?? value.text));
  if (value.reviewedAiOriginalText && value.aiOriginalText && value.reviewedAiOriginalText !== value.aiOriginalText) {
    details.append(create("p", "semantic-trace-original-label", {}, "Current regenerated AI trace"));
    details.append(create("p", "semantic-trace-original-text", {}, value.aiOriginalText));
  }
  return details;
}

function renderTraceFeedback(turn, value) {
  const actions = create("div", "trace-feedback");
  const accept = create("button", "trace-feedback-button", { type: "button" }, "Accept");
  const edit = create("button", "trace-feedback-button", { type: "button" }, "Edit label");
  const reject = create("button", "trace-feedback-button", { type: "button" }, "Reject");
  if (value.userFeedback?.verdict === "accepted") accept.classList.add("active");
  if (value.userFeedback?.verdict === "edited") edit.classList.add("active");
  if (value.userFeedback?.verdict === "rejected") reject.classList.add("active");
  accept.addEventListener("click", (event) => { event.stopPropagation(); void saveTraceFeedback(turn, "accepted"); });
  reject.addEventListener("click", (event) => { event.stopPropagation(); void saveTraceFeedback(turn, "rejected"); });
  edit.addEventListener("click", (event) => { event.stopPropagation(); showTraceEditor(turn, value, actions); });
  if (value.text) actions.append(accept, reject);
  if (state.userOverrides?.available) actions.append(edit);
  if (value.userLabel || value.userFeedback?.verdict === "edited") actions.append(restoreAutomaticButton({ providerSessionId: turn.sessionId ?? state.selectedSession?.providerSessionId }, "label", turn.id));
  return actions;
}

async function showTraceEditor(turn, value, actions) {
  const session = { providerSessionId: turn.sessionId ?? state.selectedSession?.providerSessionId };
  let override;
  try { override = (await readManualOverride(session, "label", turn.id)).override; }
  catch (error) { return showToast(error.message); }
  const editor = create("div", "trace-editor");
  const input = create("textarea", "trace-editor-input", { maxlength: "240", rows: "3", "aria-label": "Edited Semantic Trace" });
  input.value = override.value?.label ?? value.navigationLabel ?? value.displayText ?? value.text ?? "";
  const controls = create("div", "trace-editor-controls");
  const save = create("button", "trace-feedback-button active", { type: "button" }, "Save edit");
  const cancel = create("button", "trace-feedback-button", { type: "button" }, "Cancel");
  save.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      const result = await writeManualOverride(session, "label", { label: input.value }, override.revision, turn.id);
      applyGeneratedTrace(session.providerSessionId, turn.id, result.semanticTrace);
      showManualUndo("Turn label saved", result.edit);
    } catch (error) { showToast(error.message); }
  });
  cancel.addEventListener("click", (event) => { event.stopPropagation(); editor.replaceWith(renderTraceFeedback(turn, value)); });
  controls.append(save, cancel);
  editor.append(input, controls);
  actions.replaceWith(editor);
  input.focus();
}

async function saveTraceFeedback(turn, verdict, editedText) {
  const scrollTop = elements["turn-list"].scrollTop;
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(turn.sessionId ?? state.selectedSession?.providerSessionId)}/turns/${encodeURIComponent(turn.id)}/semantic-trace/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict, editedText }),
    });
    const currentTurn = state.turns.find((candidate) => candidate.id === turn.id);
    if (currentTurn) currentTurn.semanticTrace = result.semanticTrace;
    renderTranscript();
    elements["turn-list"].scrollTop = scrollTop;
    showToast(`Trace ${verdict}`);
  } catch (error) { showToast(error.message); }
}

function renderBatchGenerationState(sessionId) {
  const batch = state.batchGeneration;
  elements["generate-session-traces"].hidden = !state.semanticTraces?.generationAvailable;
  elements["generate-session-traces"].disabled = Boolean(batch);
  elements["generate-session-traces"].textContent = batch ? "Generating Session traces…" : "Generate missing traces";
  if (!batch) {
    const summary = state.batchSummary?.sessionId === sessionId ? state.batchSummary.label : undefined;
    elements["batch-trace-progress"].hidden = !summary;
    elements["batch-trace-progress"].textContent = summary ?? "";
    return;
  }
  elements["batch-trace-progress"].hidden = false;
  elements["batch-trace-progress"].textContent = batch.sessionId === sessionId
    ? batch.label
    : "Another Session batch is running";
}

async function generateSessionTraces() {
  if (!state.selectedSession || state.batchGeneration) return;
  const sessionId = state.selectedSession.providerSessionId;
  const batch = { sessionId, label: "Loading all Turns…", generated: 0, warnings: 0, failed: 0, reused: 0 };
  state.batchGeneration = batch;
  renderBatchGenerationState(sessionId);
  for (const id of state.expandedForestSessions) refreshForestTraces(id);
  try {
    const turns = await loadAllSessionTurns(sessionId);
    state.forestTurnCache.set(sessionId, { loading: false, turns });
    refreshForestTraces(sessionId);
    if (state.selectedSession?.providerSessionId === sessionId) {
      const byId = new Map(turns.map((turn) => [turn.id, turn]));
      for (const turn of state.turns) if (byId.has(turn.id)) turn.semanticTrace = byId.get(turn.id).semanticTrace;
      const scrollTop = elements["turn-list"].scrollTop;
      renderTranscript();
      elements["turn-list"].scrollTop = scrollTop;
    }
    const candidates = turns.filter((turn) => turn.semanticTrace?.freshness === "missing" || turn.semanticTrace?.freshness === "stale");
    batch.reused = turns.length - candidates.length;
    batch.label = candidates.length ? `0 / ${candidates.length} generated` : `0 generated · ${batch.reused} current reused`;
    renderBatchGenerationState(state.selectedSession?.providerSessionId);
    for (const [index, turn] of candidates.entries()) {
      try {
        const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turn.id)}/semantic-trace`, { method: "POST" });
        applyGeneratedTrace(sessionId, turn.id, result.semanticTrace);
        batch.generated += 1;
        if (result.semanticTrace.safetyWarning || result.semanticTrace.languageMismatch) batch.warnings += 1;
      } catch { batch.failed += 1; }
      batch.label = `${index + 1} / ${candidates.length} processed · ${batch.generated} generated · ${batch.warnings} warnings · ${batch.failed} failed`;
      renderBatchGenerationState(state.selectedSession?.providerSessionId);
    }
    batch.label = `${batch.generated} generated · ${batch.warnings} warnings · ${batch.failed} failed · ${batch.reused} current reused`;
    showToast(batch.label);
  } catch (error) {
    batch.label = `Session batch failed to start: ${error.message}`;
    showToast(batch.label);
  } finally {
    state.batchSummary = { sessionId, label: batch.label };
    state.batchGeneration = undefined;
    renderBatchGenerationState(state.selectedSession?.providerSessionId);
    for (const id of state.expandedForestSessions) refreshForestTraces(id);
  }
}

async function loadAllSessionTurns(sessionId) {
  const turns = [];
  let cursor;
  const seen = new Set();
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await api(`/api/sessions/${encodeURIComponent(sessionId)}/turns${query}`);
    turns.push(...page.data);
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return turns;
}

async function generateSemanticTrace(turn, action) {
  if (!state.selectedSession) return;
  const sessionId = turn.sessionId ?? state.selectedSession.providerSessionId;
  action.disabled = true;
  action.textContent = "Generating locally…";
  try {
    const force = turn.semanticTrace?.text ? "?force=1" : "";
    const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turn.id)}/semantic-trace${force}`, { method: "POST" });
    applyGeneratedTrace(sessionId, turn.id, result.semanticTrace);
    showToast(result.semanticTrace.safetyWarning ? "Trace generated with a safety warning" : "Semantic Trace generated");
  } catch (error) {
    showToast(error.message);
    action.disabled = false;
    action.textContent = "Try again";
  }
}

function selectTurn(turnId) {
  const startedAt = performance.now();
  state.selectedTurnId = turnId;
  for (const card of elements["turn-list"].querySelectorAll(".turn-card")) card.classList.toggle("selected", card.dataset.turnId === turnId);
  const path = buildNavigationPath(currentTarget());
  if (path !== window.location.pathname) history.pushState({}, "", path);
  focusSelectedTurn();
  recordInteractionPerformance("turn_select", startedAt, { loadedTurns: state.turns.length });
}

function shiftTurnWindow(delta) {
  state.selectedTurnId = undefined;
  state.turnWindowStart = Math.max(0, state.turnWindowStart + delta);
  const scrollTop = elements["turn-list"].scrollTop;
  renderTranscript();
  elements["turn-list"].scrollTop = scrollTop;
  const path = buildNavigationPath(currentTarget());
  if (path !== window.location.pathname) history.pushState({}, "", path);
}

function focusSelectedTurn() {
  if (!state.selectedTurnId) return;
  const card = [...elements["turn-list"].querySelectorAll(".turn-card")].find((item) => item.dataset.turnId === state.selectedTurnId);
  card?.scrollIntoView({ block: "nearest" });
}

function message(label, text, extraClass = "") {
  const wrapper = create("div", `message ${extraClass}`.trim());
  wrapper.append(create("p", "message-label", {}, label), create("p", "message-text", {}, text));
  return wrapper;
}

async function refreshSnapshot() {
  elements["refresh-button"].disabled = true;
  setBusy(true, "Reconciling read-only sources…");
  try {
    await api("/api/refresh", { method: "POST" });
    const parsed = parseNavigationPath(window.location.pathname);
    await navigate(parsed.target, { history: "replace", issue: parsed.issue });
    showToast("Snapshot refreshed");
  } catch (error) { showToast(error.message); setBusy(false, "Refresh failed"); }
  finally { elements["refresh-button"].disabled = false; }
}

function showRouteIssue(issue) {
  const messages = {
    invalid_route: "The URL is not a supported Session Map route. The nearest valid workspace was opened.",
    workspace_missing: "The requested workspace is no longer available. The nearest available workspace was opened.",
    session_missing: "The requested session is unavailable. Its workspace remains open.",
    turn_missing: "The requested turn is unavailable. Its session remains open.",
  };
  state.routeIssue = issue;
  elements["route-notice"].textContent = messages[issue] ?? "";
  elements["route-notice"].hidden = !issue;
}

async function showDiagnostics() {
  try {
    const result = await api("/api/diagnostics");
    const environment = result.environment;
    const capabilities = result.capabilities;
    const rows = [
      ["Codex source", `${result.source.status} · ${result.source.workspaces} Workspaces · ${result.source.sessions} Sessions`],
      ["Upstream policy", environment?.readOnly ? "Read-only" : "Unknown"],
      ["Ollama", `${environment?.ollama.available ? "Ready" : "Unavailable"} · ${environment?.ollama.endpoint ?? "unknown"}${environment?.ollama.reason ? ` · ${environment.ollama.reason}` : ""}`],
      ["Model", `${environment?.ollama.model ?? "unknown"} · thinking ${environment?.ollama.thinking ?? "unknown"}`],
      ["Semantic store", `${environment?.semanticStore.available ? "Ready" : "Unavailable"} · ${environment?.semanticStore.path ?? "unknown"}`],
      ["Schema", String(environment?.semanticStore.schemaVersion ?? "unknown")],
      ["Native navigation", `openSession=${Boolean(capabilities?.openSession)} · openTurn=${Boolean(capabilities?.openTurn)}`],
    ];
    elements["diagnostic-environment"].replaceChildren(...rows.map(([label, value]) => {
      const row = create("div", "diagnostic-environment-row");
      row.append(create("strong", "", {}, label), create("span", "", {}, value));
      return row;
    }));
    const countEntries = Object.entries(result.counts);
    elements["diagnostic-counts"].replaceChildren(...(countEntries.length ? countEntries.map(([code, count]) => badge(`${code}: ${count}`)) : [create("span", "item-subtitle", {}, "No diagnostics reported") ]));
    elements["diagnostic-list"].replaceChildren(...result.diagnostics.map((diagnostic) => {
      const item = create("div", "diagnostic-item");
      item.append(create("div", "diagnostic-code", {}, `${diagnostic.severity.toUpperCase()} · ${diagnostic.code}`), create("p", "diagnostic-message", {}, diagnostic.message));
      return item;
    }));
    elements["diagnostics-dialog"].showModal();
  } catch (error) { showToast(error.message); }
}

async function copySessionId() {
  if (!state.selectedSession) return;
  await navigator.clipboard.writeText(state.selectedSession.providerSessionId);
  showToast("Session ID copied");
}

async function api(path, options) {
  const response = await fetch(path, { ...options, headers: { Accept: "application/json", ...(options?.headers ?? {}) } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? `Request failed (${response.status})`);
  return value;
}

function create(tag, className = "", attributes = {}, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function badge(text, modifier = "") { return create("span", `badge ${modifier}`.trim(), {}, text); }
function formatDate(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : ""; }
function setBusy(busy, label) { elements["connection-state"].textContent = label; elements["connection-state"].classList.toggle("ready", !busy); }
function readyLabel() { return state.capabilities?.liveUpdates ? "Live read-only snapshot" : "Read-only snapshot ready"; }
function estimateContentChars(turns) {
  return turns.reduce((sum, turn) => sum
    + (turn.input?.length ?? 0)
    + (turn.assistantFinal?.length ?? 0)
    + turn.tools.reduce((toolSum, tool) => toolSum + (tool.inputSummary?.length ?? 0) + (tool.outputSummary?.length ?? 0), 0), 0);
}
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { elements.toast.hidden = true; }, 3200);
}

function manualOverridePath(session, field, turnId) {
  return `/api/sessions/${encodeURIComponent(session.providerSessionId)}/user-overrides/${field}${turnId ? `?turnId=${encodeURIComponent(turnId)}` : ""}`;
}

function readManualOverride(session, field, turnId) {
  return api(manualOverridePath(session, field, turnId));
}

function writeManualOverride(session, field, value, revision, turnId) {
  return api(manualOverridePath(session, field, turnId), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value, revision }),
  });
}

function showManualUndo(message, edit) {
  state.lastManualEdit = edit;
  showToast(message);
  const undo = create("button", "button secondary", { type: "button" }, "Undo");
  undo.addEventListener("click", () => void undoManualChange());
  elements.toast.append(undo);
  window.clearTimeout(showToast.timer);
}

function restoreAutomaticButton(session, field, turnId) {
  const button = create("button", "button secondary", { type: "button" }, "Restore automatic");
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      const { override } = await readManualOverride(session, field, turnId);
      const result = await writeManualOverride(session, field, null, override.revision, turnId);
      if (field === "title") applySemanticTitleToSession(session.providerSessionId, result.semanticTitle);
      if (field === "parent") applySemanticParentToSession(session.providerSessionId, result.semanticParent);
      if (field === "label") applyGeneratedTrace(session.providerSessionId, turnId, result.semanticTrace);
      else { await loadForest(true); renderSessions(); renderTranscript(); }
      showManualUndo("Automatic suggestion restored", result.edit);
    } catch (error) { showToast(error.message); }
  });
  return button;
}

async function undoManualChange() {
  if (state.undoBusy || !state.selectedScopeId) return;
  state.undoBusy = true;
  try {
    let edit = state.lastManualEdit?.workspace === state.selectedScopeId ? state.lastManualEdit : undefined;
    edit ??= (await api(`/api/scopes/${encodeURIComponent(state.selectedScopeId)}/user-edits/latest`)).edit;
    if (!edit) return showToast("No recent manual change to undo.");
    await api(`/api/user-edits/${encodeURIComponent(edit.id)}/undo`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: edit.revision }),
    });
    state.lastManualEdit = undefined;
    state.forestTurnCache.delete(edit.sessionId);
    if (state.expandedForestSessions.has(edit.sessionId)) state.forestTurnCache.set(edit.sessionId, { loading: false, turns: await loadAllForestTurns(edit.sessionId) });
    await navigate(currentTarget(), { history: "none", preserveScroll: elements["turn-list"].scrollTop });
    await loadForest(true);
    showToast("Manual change undone");
  } catch (error) { showToast(error.message); }
  finally { state.undoBusy = false; }
}
