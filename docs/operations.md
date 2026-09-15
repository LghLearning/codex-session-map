# Operations and recovery

Codex Session Map is a local, loopback-only companion. Codex history is opened read-only; the application never writes the Codex SQLite databases, rollout JSONL, or App Server history.

## Runtime prerequisites

- Node.js 24 or newer is required. `.node-version` records the tested version and `pnpm preflight` fails early with a Windows `-NodePath` example when an older Node is first on `PATH`.
- Ollama and `qwen3.5` are optional. Without them, browsing, Map, Search, Reader, manual overrides, and Undo remain available; only AI generation and organization are unavailable.

## Application-owned storage

The default files live under `.codex-session-map/`:

| File | Responsibility | Recovery role |
| --- | --- | --- |
| `semantic-traces.sqlite` | AI traces/titles/parent suggestions plus authoritative user titles, labels, placements, review state, revisions, and Undo history | Back up before manual edits; do not delete if user corrections must be retained |
| `search.sqlite` | Rebuildable Workspace-scoped lexical index and coverage state | Safe to rebuild with the next index run; deleting it does not remove user data |
| `organization.sqlite` | Rebuildable organization job and item history, timing metrics, and revisioned progress state | An interrupted job is marked `interrupted` and can be continued; deleting it only removes job history |

AI records and search/organization records are derived or operational data. User-owned overrides in `semantic-traces.sqlite` are authoritative and are not disposable cache entries.

## Recovery paths

- **Search index:** restart or reopen the Workspace. Existing documents are reused by source fingerprint; missing or stale Sessions are refreshed. An unknown source update falls back to a full Workspace reconciliation. A new index may report incomplete coverage while it builds.
- **Interrupted organization:** reopen the Organizer and choose Continue. Completed items remain preserved, active work is not silently restarted, and failed/stale items can be retried. Pause waits for the current model operation; Cancel prevents late results from committing.
- **Live progress:** the browser accepts only increasing per-job revisions. After an SSE reconnect it reads the latest job state, while the low-frequency polling fallback covers a disconnected stream.
- **Backup:** stop the server and copy the entire `.codex-session-map/` directory. Restoring that directory restores user overrides and local derived state without touching Codex history.

No cloud analytics, remote search service, or Codex upstream mutation is part of this runtime.
