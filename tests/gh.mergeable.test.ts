import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMergeable } from "../src/gh.ts";

test("normalizeMergeable: known values pass through", () => {
  assert.equal(normalizeMergeable("MERGEABLE"), "MERGEABLE");
  assert.equal(normalizeMergeable("CONFLICTING"), "CONFLICTING");
  assert.equal(normalizeMergeable("UNKNOWN"), "UNKNOWN");
});

test("normalizeMergeable: whitespace and case normalized", () => {
  assert.equal(normalizeMergeable("  mergeable\n"), "MERGEABLE");
  assert.equal(normalizeMergeable("conflicting"), "CONFLICTING");
});

test("normalizeMergeable: unrecognized values fall back to UNKNOWN", () => {
  assert.equal(normalizeMergeable(""), "UNKNOWN");
  assert.equal(normalizeMergeable("null"), "UNKNOWN");
  assert.equal(normalizeMergeable("BLOCKED"), "UNKNOWN");
});
