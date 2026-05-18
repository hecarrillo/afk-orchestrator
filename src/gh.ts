// Thin typed wrapper around the gh CLI. We shell out so the user's existing
// auth + protocol just works. No mocks; the orchestrator is intentionally
// integration-shaped against gh.

import { execa } from "execa";
import { config } from "./config.ts";

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: { name: string }[];
  url: string;
}

export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
  kind: "review" | "review-comment" | "issue-comment";
  state?: string;        // for kind === "review": APPROVED / CHANGES_REQUESTED / COMMENTED
  path?: string;          // for inline review comments
  line?: number;
}

export interface PrRef {
  number: number;
  url: string;
  state: string;
}

async function gh(args: string[]): Promise<string> {
  const result = await execa(config.ghBin, args, { reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export async function listOpenIssuesByLabel(label: string): Promise<Issue[]> {
  const out = await gh([
    "issue", "list",
    "--repo", config.repo,
    "--label", label,
    "--state", "open",
    "--limit", "200",
    "--json", "number,title,body,state,labels,url",
  ]);
  return JSON.parse(out) as Issue[];
}

export async function getIssue(number: number): Promise<Issue> {
  const out = await gh([
    "issue", "view", String(number),
    "--repo", config.repo,
    "--json", "number,title,body,state,labels,url",
  ]);
  return JSON.parse(out) as Issue;
}

export async function addLabels(number: number, names: string[]): Promise<void> {
  if (names.length === 0) return;
  await gh([
    "issue", "edit", String(number),
    "--repo", config.repo,
    "--add-label", names.join(","),
  ]);
}

export async function removeLabels(number: number, names: string[]): Promise<void> {
  if (names.length === 0) return;
  await gh([
    "issue", "edit", String(number),
    "--repo", config.repo,
    "--remove-label", names.join(","),
  ]);
}

export async function commentOnIssue(number: number, body: string): Promise<void> {
  await gh([
    "issue", "comment", String(number),
    "--repo", config.repo,
    "--body", body,
  ]);
}

export async function createPullRequest(opts: {
  title: string;
  body: string;
  head: string;
  base?: string;
}): Promise<string> {
  const url = await gh([
    "pr", "create",
    "--repo", config.repo,
    "--head", opts.head,
    "--base", opts.base ?? config.baseBranch,
    "--title", opts.title,
    "--body", opts.body,
  ]);
  return url.trim();
}

export async function reviewPullRequest(opts: {
  prNumber: number;
  verdict: "approve" | "request-changes" | "comment";
  body: string;
}): Promise<void> {
  const flag =
    opts.verdict === "approve" ? "--approve" :
    opts.verdict === "request-changes" ? "--request-changes" :
    "--comment";
  await gh([
    "pr", "review", String(opts.prNumber),
    "--repo", config.repo,
    flag,
    "--body", opts.body,
  ]);
}

export async function ensureLabelExists(name: string, color: string, description: string): Promise<void> {
  // gh label create returns non-zero if it already exists — that's fine.
  await execa(config.ghBin, [
    "label", "create", name,
    "--repo", config.repo,
    "--color", color,
    "--description", description,
  ], { reject: false });
}

// Parse `blocked-by: #N` lines (one per line) from an issue body. Whitespace-
// tolerant, case-insensitive on the keyword, requires a leading `#` to avoid
// matching e.g. "blocked by 5pm".
export function parseBlockedBy(body: string): number[] {
  const re = /^\s*blocked-by:\s*#(\d+)\s*$/gim;
  const nums: number[] = [];
  for (const m of body.matchAll(re)) {
    const n = Number(m[1]);
    if (!Number.isNaN(n)) nums.push(n);
  }
  return nums;
}

// Find the open PR for a given branch name. Convention: branch is afk/issue-N.
export async function findOpenPrForBranch(branch: string): Promise<PrRef | null> {
  const out = await execa(config.ghBin, [
    "pr", "list",
    "--repo", config.repo,
    "--head", branch,
    "--state", "open",
    "--json", "number,url,state",
  ], { reject: false });
  if (out.exitCode !== 0) return null;
  try {
    const arr = JSON.parse(out.stdout) as PrRef[];
    return arr[0] ?? null;
  } catch {
    return null;
  }
}

// Pull every PR review (with body), every inline review comment, and every
// issue-comment on the PR. Returned sorted chronologically — the order an
// implementer should address them.
export async function listPrFeedback(prNumber: number): Promise<PrComment[]> {
  const out: PrComment[] = [];

  // Reviews + their inline review comments
  const r = await execa(config.ghBin, [
    "pr", "view", String(prNumber),
    "--repo", config.repo,
    "--json", "reviews,comments",
  ], { reject: false });
  if (r.exitCode === 0) {
    try {
      const data = JSON.parse(r.stdout) as {
        reviews?: { author: { login: string }; body: string; createdAt: string; state: string }[];
        comments?: { author: { login: string }; body: string; createdAt: string }[];
      };
      for (const rev of data.reviews ?? []) {
        if (rev.body && rev.body.trim().length > 0) {
          out.push({
            author: rev.author?.login ?? "(unknown)",
            body: rev.body,
            createdAt: rev.createdAt,
            kind: "review",
            state: rev.state,
          });
        }
      }
      for (const c of data.comments ?? []) {
        out.push({
          author: c.author?.login ?? "(unknown)",
          body: c.body,
          createdAt: c.createdAt,
          kind: "issue-comment",
        });
      }
    } catch {
      /* ignore */
    }
  }

  // Inline review comments (`gh pr view --json` doesn't include these; use the API)
  const inline = await execa(config.ghBin, [
    "api", `repos/${config.repo}/pulls/${prNumber}/comments`, "--paginate",
  ], { reject: false });
  if (inline.exitCode === 0) {
    try {
      const arr = JSON.parse(inline.stdout) as {
        user: { login: string };
        body: string;
        created_at: string;
        path: string;
        line?: number;
      }[];
      for (const c of arr) {
        out.push({
          author: c.user?.login ?? "(unknown)",
          body: c.body,
          createdAt: c.created_at,
          kind: "review-comment",
          path: c.path,
          line: c.line,
        });
      }
    } catch {
      /* ignore */
    }
  }

  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Read the attempt count off an issue. Convention: a label `afk-attempts-N`.
// Returns 0 if no attempts label is present.
export function getAttemptCount(issue: Issue): number {
  for (const l of issue.labels) {
    const m = l.name.match(/^afk-attempts-(\d+)$/);
    if (m && m[1]) return Number(m[1]);
  }
  return 0;
}

// Increment the attempt count label on an issue. Returns the new count.
// Idempotent enough: removes any existing attempt label before adding the new one.
export async function bumpAttemptCount(issue: Issue): Promise<number> {
  const current = getAttemptCount(issue);
  const next = current + 1;
  // Remove any stale attempts label (covers up to 9 — enough for any sane cap)
  for (let i = 1; i <= 9; i++) {
    if (i === next) continue;
    await execa(config.ghBin, [
      "issue", "edit", String(issue.number),
      "--repo", config.repo,
      "--remove-label", `afk-attempts-${i}`,
    ], { reject: false });
  }
  await ensureLabelExists(`afk-attempts-${next}`, "F9D0C4", `AFK orchestrator: attempt #${next} on this issue`);
  await addLabels(issue.number, [`afk-attempts-${next}`]);
  return next;
}

// Clear all attempt labels (used when an issue is merged successfully).
export async function clearAttemptCount(issueNumber: number): Promise<void> {
  for (let i = 1; i <= 9; i++) {
    await execa(config.ghBin, [
      "issue", "edit", String(issueNumber),
      "--repo", config.repo,
      "--remove-label", `afk-attempts-${i}`,
    ], { reject: false });
  }
}
