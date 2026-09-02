export function parseNavigationPath(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  if (!segments.length) return { target: {} };
  const validShape = segments[0] === "workspaces"
    && (segments.length === 2
      || (segments.length === 4 && segments[2] === "sessions")
      || (segments.length === 6 && segments[2] === "sessions" && segments[4] === "turns"));
  if (!validShape) return { target: {}, issue: "invalid_route" };
  try {
    return {
      target: {
        scopeId: decodeURIComponent(segments[1]),
        sessionId: segments.length >= 4 ? decodeURIComponent(segments[3]) : undefined,
        turnId: segments.length === 6 ? decodeURIComponent(segments[5]) : undefined,
      },
    };
  } catch {
    return { target: {}, issue: "invalid_route" };
  }
}

export function buildNavigationPath(target) {
  if (!target.scopeId) return "/";
  let path = `/workspaces/${encodeURIComponent(target.scopeId)}`;
  if (!target.sessionId) return path;
  path += `/sessions/${encodeURIComponent(target.sessionId)}`;
  if (!target.turnId) return path;
  return `${path}/turns/${encodeURIComponent(target.turnId)}`;
}

export function resolveNavigationAvailability(requested, available) {
  const scopeId = available.scopeIds.includes(requested.scopeId) ? requested.scopeId : available.scopeIds[0];
  if (!scopeId) return { target: {}, issue: requested.scopeId ? "workspace_missing" : undefined };
  if (requested.scopeId && requested.scopeId !== scopeId) return { target: { scopeId }, issue: "workspace_missing" };
  if (!requested.sessionId) return { target: { scopeId } };
  if (!available.sessionIds.includes(requested.sessionId)) return { target: { scopeId }, issue: "session_missing" };
  if (!requested.turnId) return { target: { scopeId, sessionId: requested.sessionId } };
  if (!available.turnIds.includes(requested.turnId)) return { target: { scopeId, sessionId: requested.sessionId }, issue: "turn_missing" };
  return { target: { scopeId, sessionId: requested.sessionId, turnId: requested.turnId } };
}
