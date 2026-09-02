# Third-party notices

This file records both incorporated implementation ideas and reserved integration seams. C1 is a new repository; it does not vendor an upstream repository or generated Codex protocol bundle.

## w4llisz/codex-visualizer

- Upstream: https://github.com/w4llisz/codex-visualizer
- Audited commit: `409c50cd742cf3db7f1716d48c4c1f7cf06a4778`
- License: MIT
- Adapted responsibility: JSON-RPC request correlation, initialization lifecycle, notification dispatch, and thread/turn projection concepts from `src/codex-app-server-client.js` and the generated `protocol/` shape.
- Local changes: clean-room stdio transport; read-only method allowlist; request timeout; typed error classification; one reconnect attempt; pagination; experimental capability probe; version-skew diagnostics; no copied generated protocol tree.

MIT notice:

> Copyright (c) 2026 w4llis
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## someonegg/codex_viewer

- Upstream: https://github.com/someonegg/codex_viewer
- Audited commit: `ee6a9dc8f00b384203562464597e1d4fec1298aa`
- License: MIT
- Adapted responsibility: newline-committed partial JSONL decoding, checkpoint append semantics, archive directory discovery, bounded diagnostics, and fixture patterns from `src/server/adapters/codex/rollout-decoder.ts` and its tests.
- Local changes: clean-room decoder with a smaller C1 checkpoint; records are aggregated by native session id across physical files; JSONL is reconciliation-only; Codex file paths remain adapter-internal.

MIT notice:

> Copyright (c) 2026 kngin
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## openai/euphony

- Upstream: https://github.com/openai/euphony
- Audited commit: `6932db7728137b6fadc1cf7a77931358548e2b42`
- License: Apache-2.0
- C1 use: no source copied or dependency added. `packages/transcript` defines a renderer seam for a later `euphony-conversation` integration.
- Future obligation: if integrated, preserve Apache-2.0 attribution/NOTICE material and mark modified files.

## Renaissance-Mind/CodexGraph

- C1 use: clean-room visual reference only; no source copied and no Git-DAG model imported into Core.
