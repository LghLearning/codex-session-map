# Security

Please do not include private Codex transcripts, local database files, credentials, or model logs in a public issue.

Report a suspected security issue privately to the repository owner before publishing details. Include a minimal reproduction, affected version/commit, and whether the issue involves the read-only Codex boundary, local HTTP server, stored user data, or Markdown rendering.

The application is designed for local loopback use. Codex sources are read-only, and raw User/Assistant content is rendered through the safe Markdown path rather than injected as HTML.
