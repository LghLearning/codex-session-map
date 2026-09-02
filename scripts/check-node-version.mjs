import { pathToFileURL } from "node:url";

export function supportsNodeVersion(version) {
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  return Number.isInteger(major) && major >= 24;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const detected = process.versions.node;
  if (!supportsNodeVersion(detected)) {
    console.error(`Codex Session Map requires Node >= 24. Detected: Node ${detected}`);
    process.exitCode = 1;
  } else console.log(`Node ${detected} · Ready`);
}
