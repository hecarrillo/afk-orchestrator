import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { autoDetectBase } from "../src/bootstrap.ts";

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

test("autoDetectBase: returns base working tree when called from inside a worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "afk-bootstrap-test-"));
  try {
    const base = resolve(realpathSync(root), "base");
    const wt = resolve(realpathSync(root), "wt-issue-1");
    sh(`mkdir -p ${base}`, root);
    sh("git init -q -b main", base);
    sh("git config user.email test@example.com && git config user.name test", base);
    writeFileSync(join(base, "README.md"), "hello\n");
    sh("git add . && git commit -q -m init", base);
    sh(`git worktree add -q ${wt}`, base);

    const detected = autoDetectBase(wt);
    assert.equal(detected, base, `expected ${base}, got ${detected}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("autoDetectBase: throws when called outside any git repo", () => {
  const root = mkdtempSync(join(tmpdir(), "afk-bootstrap-test-"));
  try {
    assert.throws(() => autoDetectBase(root), /not a git/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("autoDetectBase: returns repo root when called from the base (non-worktree)", () => {
  const root = mkdtempSync(join(tmpdir(), "afk-bootstrap-test-"));
  const realRoot = realpathSync(root);
  try {
    sh("git init -q -b main", realRoot);
    sh("git config user.email test@example.com && git config user.name test", realRoot);
    writeFileSync(join(realRoot, "README.md"), "hello\n");
    sh("git add . && git commit -q -m init", realRoot);

    const detected = autoDetectBase(realRoot);
    assert.equal(detected, realRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
