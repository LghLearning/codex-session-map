# C1 architecture

## Boundary

Core owns provider-neutral identities and health states. The Codex adapter owns app-server protocol shapes, SQLite table names, file paths, JSONL events, source precedence, and diagnostics. The UI consumes only Core DTOs plus a separately requested diagnostics view.

```text
apps/local-web (loopback server + read-only browser UI)
       |                 |
       |                 +-- packages/transcript (view projection)
       v
packages/core <--- packages/codex-adapter
                            |
                            +-- app-server source
                            +-- read-only SQLite source
                            +-- segmented rollout reconciliation

packages/semantic-store (C2 rebuildable Turn traces; app-owned SQLite)
```

## Identity rules

- WorkspaceScope is a grouping projection. Explicit Codex project assignment wins, then selected project roots, then canonical cwd, then the unscoped/ambiguous buckets.
- Session identity is the stable provider session id. Any number of physical rollout segments may contribute provenance to one Session.
- Turn identity is the opaque native turn id whenever available. Ordinals are display-only.
- NativeLineage is upstream provenance, never a semantic parent edge.
- Unknown Codex fields are retained only in adapter-internal records or surfaced as diagnostics, never added ad hoc to Core.

## Read-only enforcement

- App-server calls pass through a compile-time and runtime allowlist.
- `thread/list` forces `useStateDbOnly: true` to disable scan-and-repair.
- The default transport is `app-server proxy`, attaching to an existing Desktop control socket. Starting a new app-server is explicit opt-in because initialization can perform SQLite runtime housekeeping.
- `thread/read`, `thread/turns/list`, and `thread/items/list` are read paths and never resume a thread.
- SQLite connections use read-only mode and query only known columns after schema probing.
- Rollouts are opened with read access. Unterminated final lines remain uncommitted.

The adapter's filesystem watcher is an optimization, not an event bus. Startup and periodic reconciliation remain correctness paths when watcher events are coalesced or lost. `LiveSessionProvider` is an optional Core capability, so providers without live notifications retain the same read API.

## Local Web boundary

The HTTP host depends on `SessionProvider`, not `CodexAdapterV1`. It publishes scopes and sessions as Core DTOs, and turns through the provider-neutral transcript projection. Provider cursor values remain opaque inside a composite UI cursor, allowing hidden-session filtering without scanning all history for every page.

The host binds to loopback, rejects non-loopback Host headers, serves no Codex mutation route, and inserts transcript data with `textContent`. Its refresh endpoint only rebuilds the adapter's in-memory read snapshot.

For live updates, the host exposes a same-origin Server-Sent Events endpoint. A source invalidation first rebuilds the read-only Adapter snapshot, then publishes only revision metadata. The browser loads the new Core pages in the background and atomically replaces its view state, preserving the selected Scope and Session where those identities still exist.

## C2 semantic boundary

Turn Semantic Trace is a provider-neutral derived projection keyed by opaque Turn identity. The semantic store receives Core Turns and never reads Codex internals directly. Its SQLite database is application-owned and contains rebuildable generated traces only. Generator identity and a public-content fingerprint control staleness. NativeLineage, Semantic Parent, Session titles, and authoritative user state remain separate concepts and are not represented by the C2 trace table.
