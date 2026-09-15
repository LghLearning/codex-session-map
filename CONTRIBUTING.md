# Contributing

Use Node 24 or newer and install with the frozen lockfile:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm preflight
```

Before opening a change, run:

```powershell
pnpm test
pnpm typecheck:map
pnpm build:map
pnpm check:readonly
git diff --check
```

Keep Codex access read-only. Preserve opaque Session and native Turn identities, keep AI records separate from user-owned overrides, and prefer a focused patch over formatting or unrelated refactoring. Do not commit `.codex-session-map/`, real transcripts, benchmark output containing private data, or local model logs.
