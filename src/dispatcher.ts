// One issue, end to end: worktree → implementer agent → reviewer agent →
// (always) PR + label transition → cleanup. Returns a structured outcome the
// caller can log or persist.
//
// Key behaviour: the dispatcher ALWAYS pushes the branch and opens (or reuses)
// a PR — regardless of whether the auto-reviewer approves or requests changes.
// The PR is the canonical review surface. External tools (Claude review
// action, CodeRabbit, security scanners) post to PRs, not issues, so the PR
// has to exist for them to fire. The auto-reviewer's verdict goes on the PR
// as a review-comment; humans add their feedback the same way (via afk:qa).
//
// On rework dispatch, the worktree adopts the existing branch and the
// implementer prompt is augmented with every prior PR comment / review.

import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Issue,
  addLabels, removeLabels, createPullRequest, reviewPullRequest, commentOnIssue,
  findOpenPrForBranch, listPrFeedback, bumpAttemptCount, waitForMergeableResolution,
} from "./gh.ts";
import { labels } from "./labels.ts";
import {
  createOrAdoptWorktree, removeWorktree, pushBranch, commitCount, diffStats,
  mergeBaseIntoWorktree,
  type Worktree,
} from "./worktree.ts";
import { runClaude } from "./claude.ts";
import { implementerPrompt, reviewerPrompt } from "./prompts.ts";
import { config } from "./config.ts";
import { send as notify } from "./subscribers/telegram.ts";

export type DispatchOutcome =
  | { kind: "approved"; prUrl: string; reviewerReport: string; commits: number; attempt: number; isRework: boolean }
  | { kind: "needs-changes"; prUrl: string; reviewerReport: string; commits: number; attempt: number; isRework: boolean }
  | { kind: "merge-conflict"; conflictedFiles: string[]; attempt: number; isRework: boolean; prUrl?: string }
  | { kind: "implementer-blocked"; blockerReport: string; attempt: number }
  | { kind: "implementer-no-commits"; attempt: number; isRework: boolean }
  | { kind: "implementer-failed"; exitCode: number; stderr: string; attempt: number }
  | { kind: "reviewer-failed"; exitCode: number; stderr: string; attempt: number }
  | { kind: "reviewer-no-verdict"; attempt: number };

export interface DispatchResult {
  issue: Issue;
  worktree?: Worktree;
  outcome: DispatchOutcome;
  elapsedMs: number;
}

export async function dispatch(issue: Issue): Promise<DispatchResult> {
  const start = Date.now();
  const attempt = await bumpAttemptCount(issue);
  log(issue, `starting (attempt ${attempt})`);
  await transitionToInProgress(issue);

  let worktree: Worktree | undefined;
  let isRework = false;
  try {
    const result = await createOrAdoptWorktree(issue.number);
    worktree = result.wt;
    isRework = result.isRework;
    log(issue, `worktree: ${worktree.path}${isRework ? " (rework — adopted prior branch)" : ""}`);

    void notify({ kind: "dispatch.started", issueNumber: issue.number, title: issue.title, attempt, isRework });

    // On rework, find the existing PR and pull its comment thread for the
    // implementer prompt. On a fresh attempt there's no PR yet.
    let existingPr: { number: number; url: string; state: string } | null = null;
    let priorFeedback: Awaited<ReturnType<typeof listPrFeedback>> = [];
    if (isRework) {
      existingPr = await findOpenPrForBranch(worktree.branch);
      if (existingPr) {
        priorFeedback = await listPrFeedback(existingPr.number);
        log(issue, `loaded ${priorFeedback.length} prior comment(s) from PR #${existingPr.number}`);
      }
    }

    // ── implementer ────────────────────────────────────────────────────────
    log(issue, "implementer dispatching");
    const impl = await runClaude({
      cwd: worktree.path,
      prompt: implementerPrompt(issue, priorFeedback),
      timeoutMs: config.implementerTimeoutMs,
      label: `impl-${issue.number}`,
    });

    if (impl.timedOut) {
      return await terminateAsFailed(issue, worktree, attempt, start, {
        kind: "implementer-failed", exitCode: -1, stderr: "timeout", attempt,
      }, "Implementer timed out.");
    }
    if (impl.exitCode !== 0) {
      return await terminateAsFailed(issue, worktree, attempt, start, {
        kind: "implementer-failed", exitCode: impl.exitCode, stderr: impl.stderr, attempt,
      }, `Implementer exited ${impl.exitCode}.\n\nstderr:\n\`\`\`\n${impl.stderr.slice(-2000)}\n\`\`\``);
    }

    const blockerPath = join(worktree.path, "AFK_BLOCKED.md");
    if (existsSync(blockerPath)) {
      const blockerReport = await readFile(blockerPath, "utf8");
      return await terminateAsFailed(issue, worktree, attempt, start, {
        kind: "implementer-blocked", blockerReport, attempt,
      }, `Implementer reported a blocker:\n\n${blockerReport}`);
    }

    const commits = await commitCount(worktree);
    if (commits === 0) {
      return await terminateAsFailed(issue, worktree, attempt, start, {
        kind: "implementer-no-commits", attempt, isRework,
      }, "Implementer exited cleanly but made zero commits.");
    }
    log(issue, `implementer made ${commits} commit(s)`);
    void notify({ kind: "implementer.finished", issueNumber: issue.number, commits, elapsedMs: impl.elapsedMs });

    // ── sync with base ─────────────────────────────────────────────────────
    // Merge the latest `origin/<baseBranch>` into the branch BEFORE the
    // reviewer runs and BEFORE the PR is pushed. If the merge conflicts,
    // requeue immediately — the reviewer would have nothing useful to say
    // about a conflicting tree, and we never want to ask a human to QA a
    // PR that GitHub will refuse to merge. The implementer gets another
    // shot on the next planner round, this time with the conflict files
    // and base SHA inlined in its prompt (rework path picks them up via
    // priorFeedback automatically).
    log(issue, `syncing with origin/${config.baseBranch}`);
    const mergeOutcome = await mergeBaseIntoWorktree(worktree);
    if (mergeOutcome.kind === "conflict") {
      const list = mergeOutcome.conflictedFiles.length > 0
        ? mergeOutcome.conflictedFiles.map((f) => `- \`${f}\``).join("\n")
        : "(git did not report individual file paths)";
      const summary =
        `Auto-merge of \`origin/${config.baseBranch}\` into \`${worktree.branch}\` conflicted; requeueing for rework.\n\n` +
        `Conflicted paths:\n${list}\n\n` +
        `The branch was reset to its pre-merge HEAD. The implementer will see this comment as prior feedback on the next planner round and should re-resolve the integration in its own commits.`;
      log(issue, `merge conflict on ${mergeOutcome.conflictedFiles.length} file(s) — requeueing`);
      // Push the branch FIRST so a PR exists and the comment thread is the
      // canonical conversation surface. If push fails (e.g. branch protection
      // disallows non-fast-forward), fall back to commenting on the issue.
      let prUrlForComment: string | undefined;
      const pushAttempt = await pushBranch(worktree).then(() => true).catch(() => false);
      if (pushAttempt) {
        let prRef = existingPr ?? await findOpenPrForBranch(worktree.branch).catch(() => null);
        if (!prRef) {
          const created = await createPullRequest({
            title: `${truncate(issue.title, 70)} (closes #${issue.number})`,
            body: `Resolves #${issue.number}.\n\n**Conflict-pending** — automerge with \`${config.baseBranch}\` failed; awaiting implementer rework.\n\n🤖 Opened by AFK orchestrator.`,
            head: worktree.branch,
          }).catch(() => null);
          if (created) {
            prRef = { number: parsePrNumber(created) ?? 0, url: created, state: "OPEN" };
          }
        }
        if (prRef) {
          prUrlForComment = prRef.url;
          await reviewPullRequest({ prNumber: prRef.number, verdict: "comment", body: summary }).catch(() => {});
        }
      }
      return await requeueAsNeedsChanges(issue, worktree, attempt, start, {
        kind: "merge-conflict",
        conflictedFiles: mergeOutcome.conflictedFiles,
        attempt,
        isRework,
        prUrl: prUrlForComment,
      }, prUrlForComment ? `Merge conflict on ${mergeOutcome.conflictedFiles.length} file(s); see ${prUrlForComment}` : summary);
    }
    if (mergeOutcome.kind === "merged") {
      log(issue, `merged origin/${config.baseBranch} into ${worktree.branch}`);
    } else {
      log(issue, `base is up-to-date — no merge needed`);
    }

    // ── reviewer ───────────────────────────────────────────────────────────
    await transitionToNeedsReview(issue);
    const stats = await diffStats(worktree);
    log(issue, "reviewer dispatching");
    const rev = await runClaude({
      cwd: worktree.path,
      prompt: reviewerPrompt(issue, stats),
      timeoutMs: config.reviewerTimeoutMs,
      label: `review-${issue.number}`,
    });

    if (rev.timedOut || rev.exitCode !== 0) {
      return await terminateAsFailed(issue, worktree, attempt, start, {
        kind: "reviewer-failed", exitCode: rev.exitCode, stderr: rev.stderr, attempt,
      }, `Reviewer ${rev.timedOut ? "timed out" : `exited ${rev.exitCode}`}.\n\nstderr:\n\`\`\`\n${rev.stderr.slice(-2000)}\n\`\`\``);
    }

    const reviewPath = join(worktree.path, "AFK_REVIEW.md");
    if (!existsSync(reviewPath)) {
      return await terminateAsFailed(issue, worktree, attempt, start, {
        kind: "reviewer-no-verdict", attempt,
      }, "Reviewer did not produce AFK_REVIEW.md.");
    }
    const reviewRaw = await readFile(reviewPath, "utf8");
    const parsed = parseReview(reviewRaw);
    if (!parsed) {
      return await terminateAsFailed(issue, worktree, attempt, start, {
        kind: "reviewer-no-verdict", attempt,
      }, "Reviewer's AFK_REVIEW.md did not start with a parseable verdict line.");
    }
    log(issue, `reviewer verdict: ${parsed.verdict}`);
    await unlink(reviewPath).catch(() => {});
    void notify({ kind: "reviewer.verdict", issueNumber: issue.number, verdict: parsed.verdict });

    // ── PR (always create or reuse, regardless of verdict) ─────────────────
    await pushBranch(worktree);

    let prNumber: number;
    let prUrl: string;
    if (existingPr) {
      prNumber = existingPr.number;
      prUrl = existingPr.url;
      log(issue, `pushed to existing PR #${prNumber}`);
      void notify({ kind: "pr.updated", issueNumber: issue.number, prNumber, prUrl, attempt });
    } else {
      const prTitle = `${truncate(issue.title, 70)} (closes #${issue.number})`;
      const prBody = renderPrBody(issue.number, parsed, attempt);
      prUrl = await createPullRequest({ title: prTitle, body: prBody, head: worktree.branch });
      const n = parsePrNumber(prUrl);
      if (n === null) {
        return await terminateAsFailed(issue, worktree, attempt, start, {
          kind: "reviewer-failed", exitCode: 0, stderr: "couldn't parse PR number from URL", attempt,
        }, `Could not parse PR number from URL: ${prUrl}`);
      }
      prNumber = n;
      log(issue, `opened PR #${prNumber}: ${prUrl}`);
      void notify({ kind: "pr.opened", issueNumber: issue.number, prNumber, prUrl });
    }

    // Auto-reviewer posts its verdict as a PR review-comment. Always
    // `--comment` (not --approve / --request-changes) — the human is the
    // actual approver, and GitHub blocks self-approve/reject on owner PRs.
    const verdictLabel = parsed.verdict === "approve" ? "APPROVE" : "REQUEST CHANGES";
    const reviewBody = `**AFK reviewer (attempt ${attempt}) verdict: ${verdictLabel}** — informational; ${parsed.verdict === "approve" ? "awaiting human QA" : "implementer will re-run on next planner round"}.\n\n${parsed.body}`;
    await reviewPullRequest({ prNumber, verdict: "comment", body: reviewBody }).catch(err => {
      process.stderr.write(`[dispatch ${issue.number}] WARN: could not post PR review (${err instanceof Error ? err.message : String(err)}); report is in the PR body.\n`);
    });

    // ── post-push mergeability check ──────────────────────────────────────
    // We merged the latest base in before the reviewer, so this *should* be
    // MERGEABLE. The window for CONFLICTING is the few seconds between our
    // in-worktree merge and the push — if a teammate landed a conflicting
    // commit on `main` in that gap, GitHub will flag the PR. Override the
    // reviewer's verdict in that case and requeue — never invite the human
    // to QA a conflicting PR.
    const mergeable = await waitForMergeableResolution(prNumber).catch(() => "UNKNOWN" as const);
    if (mergeable === "CONFLICTING") {
      log(issue, `PR #${prNumber} flagged CONFLICTING by GitHub after push — requeueing`);
      const summary =
        `GitHub flagged this PR as conflicting after push (race vs. \`${config.baseBranch}\`); requeueing for rework. ` +
        `The next attempt will re-merge \`origin/${config.baseBranch}\` and try again.`;
      await reviewPullRequest({ prNumber, verdict: "comment", body: summary }).catch(() => {});
      return await requeueAsNeedsChanges(issue, worktree, attempt, start, {
        kind: "merge-conflict",
        conflictedFiles: [],
        attempt,
        isRework,
        prUrl,
      }, `PR #${prNumber} CONFLICTING — see ${prUrl}`);
    }

    // ── label transition ──────────────────────────────────────────────────
    if (parsed.verdict === "approve") {
      await transitionToNeedsHumanQa(issue, prUrl);
      void notify({ kind: "outcome", issueNumber: issue.number, outcomeKind: "approved", prUrl });
      // Successful dispatch — drop the local worktree. The remote branch
      // carries the canonical history; on rework, createOrAdoptWorktree
      // fetches a fresh checkout from origin anyway.
      await removeWorktree(worktree).catch(() => {});
      return {
        issue, worktree,
        outcome: { kind: "approved", prUrl, reviewerReport: parsed.body, commits, attempt, isRework },
        elapsedMs: Date.now() - start,
      };
    } else {
      // Auto-reviewer requested changes — drop back to needs-changes so the
      // next planner round picks it up automatically (with the new PR review
      // included in priorFeedback).
      await removeLabels(issue.number, [labels.inProgress, labels.needsReview, labels.needsHumanQa]).catch(() => {});
      await addLabels(issue.number, [labels.needsChanges]);
      await commentOnIssue(issue.number, `Auto-reviewer requested changes on attempt ${attempt}: ${prUrl}\n\nPlanner will re-dispatch on next round with prior comments inlined.`);
      void notify({ kind: "outcome", issueNumber: issue.number, outcomeKind: "needs-changes", prUrl });
      // Rework will re-fetch the branch fresh from origin; the local
      // working tree has no information rework needs.
      await removeWorktree(worktree).catch(() => {});
      return {
        issue, worktree,
        outcome: { kind: "needs-changes", prUrl, reviewerReport: parsed.body, commits, attempt, isRework },
        elapsedMs: Date.now() - start,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await transitionToNeedsChangesGenerically(issue, `Orchestrator error: ${msg}`).catch(() => {});
    throw err;
  }
}

async function terminateAsFailed(
  issue: Issue,
  worktree: Worktree,
  _attempt: number,
  start: number,
  outcome: DispatchOutcome,
  message: string,
): Promise<DispatchResult> {
  await transitionToNeedsChangesGenerically(issue, message);
  void notify({ kind: "failure", issueNumber: issue.number, reason: message.split("\n")[0] ?? "unknown" });
  return { issue, worktree, outcome, elapsedMs: Date.now() - start };
}

/**
 * Terminate as a recoverable rework — used when something detectable went
 * wrong but the implementer should get another shot (e.g. a base-branch
 * merge conflict). Differs from `terminateAsFailed` in two ways: the issue
 * comment is the verbatim summary (already written for human readers, not
 * a stack trace), and the worktree is removed because rework will re-fetch
 * from origin anyway. The notify event is `outcome: needs-changes` so the
 * round summary stays accurate.
 */
async function requeueAsNeedsChanges(
  issue: Issue,
  worktree: Worktree,
  _attempt: number,
  start: number,
  outcome: DispatchOutcome,
  summary: string,
): Promise<DispatchResult> {
  await transitionToNeedsChangesGenerically(issue, summary);
  void notify({ kind: "outcome", issueNumber: issue.number, outcomeKind: "needs-changes" });
  await removeWorktree(worktree).catch(() => {});
  return { issue, worktree, outcome, elapsedMs: Date.now() - start };
}

function parseReview(raw: string): { verdict: "approve" | "request-changes"; body: string } | null {
  const lines = raw.split("\n");
  const first = (lines[0] ?? "").trim();
  const verdict =
    first === "verdict: approve" ? "approve" :
    first === "verdict: request-changes" ? "request-changes" :
    null;
  if (!verdict) return null;
  const sep = lines.findIndex(l => l.trim() === "---");
  const body = sep >= 0 ? lines.slice(sep + 1).join("\n").trim() : lines.slice(1).join("\n").trim();
  return { verdict, body };
}

function parsePrNumber(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m && m[1] ? Number(m[1]) : null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function renderPrBody(issueNumber: number, parsed: { verdict: string; body: string }, attempt: number): string {
  return `Resolves #${issueNumber}.

## Reviewer report (automated, attempt ${attempt})

**Verdict: ${parsed.verdict.toUpperCase()}**

${parsed.body}

---

🤖 Generated by AFK orchestrator. ${parsed.verdict === "approve" ? "Awaiting human QA." : "Implementer will re-run on next planner round if not approved."}`;
}

async function transitionToInProgress(issue: Issue): Promise<void> {
  await removeLabels(issue.number, [labels.prdReady, labels.needsChanges, labels.needsReview, labels.needsHumanQa]).catch(() => {});
  await addLabels(issue.number, [labels.inProgress]);
}

async function transitionToNeedsReview(issue: Issue): Promise<void> {
  await removeLabels(issue.number, [labels.inProgress]).catch(() => {});
  await addLabels(issue.number, [labels.needsReview]);
}

async function transitionToNeedsHumanQa(issue: Issue, prUrl: string): Promise<void> {
  await removeLabels(issue.number, [labels.inProgress, labels.needsReview, labels.needsChanges]).catch(() => {});
  await addLabels(issue.number, [labels.needsHumanQa]);
  await commentOnIssue(issue.number, `AFK reviewer approved; PR open for human QA: ${prUrl}`);
}

async function transitionToNeedsChangesGenerically(issue: Issue, body: string): Promise<void> {
  await removeLabels(issue.number, [labels.inProgress, labels.needsReview]).catch(() => {});
  await addLabels(issue.number, [labels.needsChanges]);
  await commentOnIssue(issue.number, body);
}

function log(issue: Issue, msg: string): void {
  process.stdout.write(`[dispatch ${issue.number}] ${msg}\n`);
}
