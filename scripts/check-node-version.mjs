import { pathToFileURL } from "node:url";

export function supportsNodeVersion(version) {
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  return Number.isInteger(major) && major >= 24;
}

export function nodeVersionError(version) {
  return [
    `Codex Session Map requires Node >= 24. Detected: Node ${version}`,
    "Install/select Node 24, or on Windows run:",
    "  powershell -ExecutionPolicy Bypass -File ./start-session-map.ps1 -NodePath C:\\path\\to\\node.exe",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const detected = process.versions.node;
  if (!supportsNodeVersion(detected)) {
    console.error(nodeVersionError(detected));
    process.exitCode = 1;
  } else console.log(`Node ${detected} · Ready`);
}
