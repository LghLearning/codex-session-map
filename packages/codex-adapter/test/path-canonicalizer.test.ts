import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeWorkspacePath } from "../src/path-canonicalizer.ts";

test("Windows extended and ordinary paths share a comparison identity", async () => {
  const extended = await canonicalizeWorkspacePath("\\\\?\\c:\\Work\\Project\\.\\");
  const ordinary = await canonicalizeWorkspacePath("C:/Work/Project");
  assert.equal(extended.comparisonKey, ordinary.comparisonKey);
  assert.equal(extended.canonical, "C:\\Work\\Project");
  assert.equal(extended.original, "\\\\?\\c:\\Work\\Project\\.\\");
});

test("Windows dot-dot and drive casing are normalized", async () => {
  const value = await canonicalizeWorkspacePath("c:\\Work\\Child\\..\\Project\\");
  assert.equal(value.canonical, "C:\\Work\\Project");
});
