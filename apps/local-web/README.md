# Local Web companion

The local companion provides a read-only React Map Workspace at `/`, with the legacy Explorer available at `/legacy`:

```text
WorkspaceScope
    -> Map / multi-root Session Forest
    -> Session details
      -> ordered Turn chain / exact native Turn Reader
```

Run it with `pnpm start` or force structured/rollout fallback with `pnpm start:fallback`. The start command builds and serves the React Map Workspace at `/`; the previous Explorer remains available at `/legacy`. It binds to loopback, never serves Codex mutation routes, and shows diagnostics instead of silently dropping partial records.

If local Ollama/qwen3.5 is available, explicit actions can generate missing/stale Traces for the current Session, a Semantic Session Title, or a Semantic Parent suggestion. These write only to the app-owned semantic store and never write Codex data.

Forest materialization is model-free. It consumes only the Sessions and semantic records already present, retains multiple confirmed roots, separates Unorganized Sessions, keeps Native Lineage separate, and lazily loads lightweight Turn directories when a node is expanded. Search is Workspace-scoped and uses the app-owned local index; selecting a result updates the shared map selection and opens the exact Turn Reader.

**Organize Workspace** is an explicit foreground operation for the selected Workspace. It fills missing Session Titles first, then missing Parent results, never starts missing Trace generation, continues after per-Session warnings, and can be cancelled between model operations. Progress uses revisioned SSE updates with an 8-second polling fallback. Supported Codex desktop Session/Turn opening is unavailable in the current environment, so the UI keeps exact navigation inside the companion and exposes Session ID copy without an internal deep-link hack.
