import { execFile } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CodexEnvironment {
  readonly codexHome: string;
  readonly appServerExecutable?: string;
  readonly backendVersion?: string;
  readonly stateDatabase?: string;
  readonly historyDatabase?: string;
  readonly sessionsDirectory: string;
  readonly archivedSessionsDirectory: string;
}

export async function detectCodexEnvironment(overrides: { codexHome?: string; appServerExecutable?: string } = {}): Promise<CodexEnvironment> {
  const home = overrides.codexHome ?? process.env.CODEX_HOME ?? join(userHome(), ".codex");
  const appServerExecutable = overrides.appServerExecutable ?? process.env.CODEX_APP_SERVER_EXECUTABLE ?? await findBundledCodexExecutable() ?? "codex";
  const names = await readdir(home).catch(() => []);
  const stateDatabase = versioned(names, /^state_(\d+)\.sqlite$/, home);
  const historyDatabase = versioned(names, /^thread_history_(\d+)\.sqlite$/, home);
  return {
    codexHome: home,
    appServerExecutable,
    backendVersion: await executableVersion(appServerExecutable),
    stateDatabase,
    historyDatabase,
    sessionsDirectory: join(home, "sessions"),
    archivedSessionsDirectory: join(home, "archived_sessions"),
  };
}

async function findBundledCodexExecutable(): Promise<string | undefined> {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return undefined;
  const bin = join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  const entries = await readdir(bin, { withFileTypes: true }).catch(() => []);
  const candidates: { path: string; modified: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(bin, entry.name, "codex.exe");
    try {
      await access(path);
      candidates.push({ path, modified: (await stat(path)).mtimeMs });
    } catch {
      // Ignore incomplete app update directories.
    }
  }
  candidates.sort((a, b) => b.modified - a.modified);
  return candidates[0]?.path;
}

async function executableVersion(executable: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(executable, ["--version"], { timeout: 5_000, windowsHide: true });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function versioned(names: readonly string[], pattern: RegExp, root: string): string | undefined {
  const found = names.flatMap((name) => {
    const match = pattern.exec(name);
    return match ? [{ name, version: Number(match[1]) }] : [];
  }).sort((a, b) => b.version - a.version)[0];
  return found ? join(root, found.name) : undefined;
}

function userHome(): string {
  const value = process.env.USERPROFILE ?? process.env.HOME;
  if (!value) throw new Error("Cannot resolve the user home directory; set CODEX_HOME explicitly.");
  return value;
}
