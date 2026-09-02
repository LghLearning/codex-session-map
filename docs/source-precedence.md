# Source precedence

| Core field | Primary | Structured fallback | Reconciliation fallback |
| --- | --- | --- | --- |
| Session id | app-server thread id | `threads.id` | `session_meta.payload.id` |
| Title | app-server name, then preview | state title/name/preview | first persisted user input |
| Project assignment | app-server project metadata when present | `threads.project_id` + `projects/project_roots` | canonical cwd grouping |
| Archive state | archived `thread/list` page | `threads.archived` | containing archive directory |
| Created/updated time | app-server thread timestamps | state timestamps | segment metadata/event timestamps |
| Turn id/status/items | paginated native turns or `thread/read` | `thread_turns` + `thread_items` | task lifecycle reconstruction |
| Native lineage | app-server native lineage | `thread_spawn_edges` where applicable | metadata hints, marked ambiguous |
| Physical provenance | n/a | rollout path registration | all matching rollout segments |

Precedence is field-level, not whole-record replacement. A lower source fills missing values, reports disagreement, and may add partial recovery without silently overriding a higher source.

JSONL is never enumerated as `one file = one Session`: every decoded `session_meta` id is aggregated before projection.
