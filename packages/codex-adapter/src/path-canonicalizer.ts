import { realpath } from "node:fs/promises";
import { basename, isAbsolute, normalize, resolve, win32 } from "node:path";

export interface CanonicalPath {
  readonly original: string;
  readonly canonical: string;
  readonly comparisonKey: string;
  readonly displayName: string;
  readonly resolvedLinks: boolean;
  readonly ambiguous: boolean;
}

export async function canonicalizeWorkspacePath(input: string): Promise<CanonicalPath> {
  const original = input.trim();
  const windows = looksWindowsPath(original);
  let candidate = windows ? normalizeWindowsPath(original) : normalize(resolve(original));
  const ambiguous = original.length === 0 || (!windows && !isAbsolute(original));
  let resolvedLinks = false;

  try {
    const physical = await realpath(candidate);
    candidate = windows ? normalizeWindowsPath(physical) : normalize(physical);
    resolvedLinks = true;
  } catch {
    // Nonexistent historical roots remain valid observations; they are not errors.
  }

  const comparisonKey = windows ? candidate.toLocaleLowerCase("en-US") : candidate;
  const displayName = windows ? win32.basename(candidate) || candidate : basename(candidate) || candidate;
  return { original, canonical: candidate, comparisonKey, displayName, resolvedLinks, ambiguous };
}

function looksWindowsPath(value: string): boolean {
  return /^(?:\\\\\?\\|\/\/\?\/|[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value);
}

function normalizeWindowsPath(value: string): string {
  let cleaned = value.replaceAll("/", "\\");
  if (cleaned.startsWith("\\\\?\\UNC\\")) cleaned = `\\\\${cleaned.slice(8)}`;
  else if (cleaned.startsWith("\\\\?\\")) cleaned = cleaned.slice(4);
  cleaned = win32.normalize(cleaned);
  if (/^[a-z]:/i.test(cleaned)) cleaned = `${cleaned[0]!.toUpperCase()}${cleaned.slice(1)}`;
  const root = win32.parse(cleaned).root;
  while (cleaned.length > root.length && cleaned.endsWith("\\")) cleaned = cleaned.slice(0, -1);
  return cleaned;
}
