import { test } from "node:test";
import assert from "node:assert/strict";
import { isZombie } from "../src/loop.ts";

const HOUR = 60 * 60 * 1000;

test("isZombie: true when updatedAt is older than threshold", () => {
  const now = Date.parse("2026-05-19T12:00:00Z");
  const updatedAt = "2026-05-19T10:00:00Z"; // 2h ago
  assert.equal(isZombie(updatedAt, now, HOUR), true);
});

test("isZombie: false when updatedAt is within threshold", () => {
  const now = Date.parse("2026-05-19T12:00:00Z");
  const updatedAt = "2026-05-19T11:30:00Z"; // 30m ago
  assert.equal(isZombie(updatedAt, now, HOUR), false);
});

test("isZombie: false when updatedAt is exactly at threshold (strict >)", () => {
  const now = Date.parse("2026-05-19T12:00:00Z");
  const updatedAt = "2026-05-19T11:00:00Z"; // exactly 1h ago
  assert.equal(isZombie(updatedAt, now, HOUR), false);
});

test("isZombie: false when updatedAt is in the future (clock skew)", () => {
  const now = Date.parse("2026-05-19T12:00:00Z");
  const updatedAt = "2026-05-19T13:00:00Z";
  assert.equal(isZombie(updatedAt, now, HOUR), false);
});

test("isZombie: false on unparseable timestamp (refuse to auto-touch)", () => {
  const now = Date.parse("2026-05-19T12:00:00Z");
  assert.equal(isZombie("not-a-date", now, HOUR), false);
  assert.equal(isZombie("", now, HOUR), false);
});
