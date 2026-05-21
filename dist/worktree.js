// Native git worktree wrapper. No Docker, no Sandcastle — for a Swift macOS
// project the host toolchain (swiftc, swift build, xcodebuild) is exactly what
// the implementer agent wants, so a Linux container would only get in the way.
//
// Two creation modes:
// - Fresh: no remote branch exists for this issue → branch from baseRef
// - Adopt: remote branch exists (from a prior rejected attempt) → check out
//   the existing branch, preserving its commits, so the next implementer
//   extends prior work instead of starting from zero.
//
// What this gives us: each agent works on its own branch with its own working
// tree; commits land directly on that branch; the main checkout is untouched.
// What it does NOT give: process isolation. The agent runs with the host
// user's permissions — accepted because --dangerously-skip-permissions is the
// explicit policy anyway.
import { execa } from "execa";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";
export async function ensureWorktreesRoot() {
    await mkdir(config.worktreesRoot, { recursive: true });
}
/// Create a fresh worktree (no remote branch) or adopt an existing one
/// (remote branch exists from a prior attempt). Returns `isRework: true`
/// when adopting, so the caller can fetch prior PR feedback.
export async function createOrAdoptWorktree(issueNumber) {
    await ensureWorktreesRoot();
    const branch = `${config.branchPrefix}issue-${issueNumber}`;
    const path = join(config.worktreesRoot, `issue-${issueNumber}`);
    // 1. Clean any stale local worktree at this path. The previous attempt's
    // worktree might still be sitting there, on a different ref or just stale.
    if (existsSync(path)) {
        await execa("git", ["-C", config.repoRoot, "worktree", "remove", "--force", path], { reject: false });
        if (existsSync(path))
            await rm(path, { recursive: true, force: true });
    }
    // Prune dangling worktree refs in .git/worktrees/
    await execa("git", ["-C", config.repoRoot, "worktree", "prune"], { reject: false });
    // 2. Refresh origin's view of both the base branch (so the fresh-create
    //    path branches from the *current* head of main, not a week-old local
    //    cache) and the issue branch (so the rework path adopts the latest
    //    remote commits, including anything the human added during QA).
    await execa("git", ["-C", config.repoRoot, "fetch", "origin", config.baseBranch], { reject: false });
    await execa("git", ["-C", config.repoRoot, "fetch", "origin", branch], { reject: false });
    const remoteRef = `refs/remotes/origin/${branch}`;
    const remoteExists = await execa("git", ["-C", config.repoRoot, "rev-parse", "--verify", remoteRef], { reject: false });
    // 3. Drop any stale local branch (no commits there we'd care about — the
    // canonical history is either on origin or about to be created).
    await execa("git", ["-C", config.repoRoot, "branch", "-D", branch], { reject: false });
    if (remoteExists.exitCode === 0) {
        // Rework: create a local branch tracking origin's commits.
        await execa("git", ["-C", config.repoRoot, "worktree", "add", "-b", branch, path, remoteRef]);
        // Set up tracking so a plain `git push` updates the existing remote branch.
        await execa("git", ["-C", path, "branch", "--set-upstream-to", `origin/${branch}`], { reject: false });
        return { wt: { path, branch }, isRework: true };
    }
    // Fresh: branch off the base.
    const baseRef = await currentBaseRef();
    await execa("git", ["-C", config.repoRoot, "worktree", "add", "-b", branch, path, baseRef]);
    return { wt: { path, branch }, isRework: false };
}
export async function removeWorktree(wt) {
    await execa("git", ["-C", config.repoRoot, "worktree", "remove", "--force", wt.path], { reject: false });
    if (existsSync(wt.path)) {
        await rm(wt.path, { recursive: true, force: true });
    }
}
export async function pushBranch(wt) {
    // `-u` is harmless on re-push; covers both fresh and rework paths.
    await execa("git", ["-C", wt.path, "push", "-u", "origin", wt.branch]);
}
export async function commitCount(wt) {
    const baseRef = await currentBaseRef();
    const { stdout } = await execa("git", ["-C", wt.path, "rev-list", "--count", `${baseRef}..HEAD`]);
    return Number(stdout.trim());
}
export async function commitCountSince(wt, baseSha) {
    const { stdout } = await execa("git", ["-C", wt.path, "rev-list", "--count", `${baseSha}..HEAD`], { reject: false });
    return Number(stdout.trim()) || 0;
}
export async function currentHeadSha(wt) {
    const { stdout } = await execa("git", ["-C", wt.path, "rev-parse", "HEAD"]);
    return stdout.trim();
}
export async function diffStats(wt) {
    const baseRef = await currentBaseRef();
    const { stdout } = await execa("git", ["-C", wt.path, "diff", "--stat", baseRef]);
    return stdout;
}
/**
 * Merge the latest `origin/<baseBranch>` into the worktree's branch so the
 * pre-review state mirrors what the eventual PR will look like on GitHub. If
 * the merge conflicts, abort it (leaving the branch at its pre-merge HEAD)
 * and return the list of conflicted paths so the dispatcher can requeue
 * without ever asking the human to review a conflicting PR.
 *
 * Always fetches `origin/<baseBranch>` first — if `currentBaseRef()` falls
 * back to a local ref (no `origin/` available), this still merges that local
 * ref, which is the best we can do without a remote.
 */
export async function mergeBaseIntoWorktree(wt) {
    await execa("git", ["-C", wt.path, "fetch", "origin", config.baseBranch], { reject: false });
    const baseRef = await currentBaseRef();
    // Skip the merge entirely if the branch already contains every commit on base.
    const ahead = await execa("git", ["-C", wt.path, "rev-list", "--count", `HEAD..${baseRef}`], { reject: false });
    if (ahead.exitCode === 0 && Number(ahead.stdout.trim()) === 0) {
        return { kind: "up-to-date" };
    }
    const baseShaProbe = await execa("git", ["-C", wt.path, "rev-parse", baseRef], { reject: false });
    const baseSha = baseShaProbe.stdout.trim();
    const merge = await execa("git", ["-C", wt.path, "merge", "--no-edit", "--no-ff", baseRef], { reject: false, env: { ...process.env, GIT_EDITOR: "true" } });
    if (merge.exitCode === 0) {
        return { kind: "merged", baseSha };
    }
    // Conflict — collect the unmerged paths, then abort so the branch returns
    // to its pre-merge state. The implementer can pick up the rework on the
    // next round with a clean tree and the conflict summary in the prompt.
    const unmerged = await execa("git", ["-C", wt.path, "diff", "--name-only", "--diff-filter=U"], { reject: false });
    const conflictedFiles = unmerged.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    await execa("git", ["-C", wt.path, "merge", "--abort"], { reject: false });
    return { kind: "conflict", conflictedFiles };
}
async function currentBaseRef() {
    const remote = `origin/${config.baseBranch}`;
    const probe = await execa("git", ["-C", config.repoRoot, "rev-parse", "--verify", remote], { reject: false });
    return probe.exitCode === 0 ? remote : config.baseBranch;
}
