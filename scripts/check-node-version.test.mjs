import assert from "node:assert/strict";
import test from "node:test";
import { supportsNodeVersion } from "./check-node-version.mjs";

test("startup Node version validation requires Node 24 or newer", () => {
  assert.equal(supportsNodeVersion("20.18.1"), false);
  assert.equal(supportsNodeVersion("v23.9.0"), false);
  assert.equal(supportsNodeVersion("24.0.0"), true);
  assert.equal(supportsNodeVersion("25.1.0"), true);
  assert.equal(supportsNodeVersion("not-a-version"), false);
});
