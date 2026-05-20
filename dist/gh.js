// Thin typed wrapper around the gh CLI. We shell out so the user's existing
// auth + protocol just works. No mocks; the orchestrator is intentionally
// integration-shaped against gh.
import { execa } from "execa";
import { config } from "./config.js";
async function gh(args) {
    const result = await execa(config.ghBin, args, { reject: false });
    if (result.exitCode !== 0) {
        throw new Error(`gh ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
}
export async function listOpenIssuesByLabel(label) {
    const out = await gh([
        "issue", "list",
        "--repo", config.repo,
        "--label", label,
        "--state", "open",
        "--limit", "200",
        "--json", "number,title,body,state,labels,url,updatedAt",
    ]);
    return JSON.parse(out);
}
export async function getIssue(number) {
    const out = await gh([
        "issue", "view", String(number),
        "--repo", config.repo,
        "--json", "number,title,body,state,labels,url,updatedAt",
    ]);
    return JSON.parse(out);
}
export async function addLabels(number, names) {
    if (names.length === 0)
        return;
    await gh([
        "issue", "edit", String(number),
        "--repo", config.repo,
        "--add-label", names.join(","),
    ]);
}
export async function removeLabels(number, names) {
    if (names.length === 0)
        return;
    await gh([
        "issue", "edit", String(number),
        "--repo", config.repo,
        "--remove-label", names.join(","),
    ]);
}
export async function commentOnIssue(number, body) {
    await gh([
        "issue", "comment", String(number),
        "--repo", config.repo,
        "--body", body,
    ]);
}
export async function createPullRequest(opts) {
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
export async function getPrMergeable(prNumber) {
    const out = await gh([
        "pr", "view", String(prNumber),
        "--repo", config.repo,
        "--json", "mergeable",
        "--jq", ".mergeable",
    ]);
    return normalizeMergeable(out);
}
/**
 * GitHub doesn't compute mergeability synchronously — a freshly-pushed PR
 * reports `UNKNOWN` for a few seconds while the background job runs. Poll
 * with light backoff and return the first definite answer. If it never
 * resolves before `timeoutMs`, return `UNKNOWN` and let the caller decide.
 */
export async function waitForMergeableResolution(prNumber, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
        const m = await getPrMergeable(prNumber).catch(() => "UNKNOWN");
        if (m !== "UNKNOWN")
            return m;
        const wait = Math.min(2000 + attempt * 1000, 5000);
        await new Promise((r) => setTimeout(r, wait));
        attempt++;
    }
    return "UNKNOWN";
}
export function normalizeMergeable(raw) {
    const v = raw.trim().toUpperCase();
    if (v === "MERGEABLE" || v === "CONFLICTING" || v === "UNKNOWN")
        return v;
    return "UNKNOWN";
}
export async function reviewPullRequest(opts) {
    const flag = opts.verdict === "approve" ? "--approve" :
        opts.verdict === "request-changes" ? "--request-changes" :
            "--comment";
    await gh([
        "pr", "review", String(opts.prNumber),
        "--repo", config.repo,
        flag,
        "--body", opts.body,
    ]);
}
export async function ensureLabelExists(name, color, description) {
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
export function parseBlockedBy(body) {
    const re = /^\s*blocked-by:\s*#(\d+)\s*$/gim;
    const nums = [];
    for (const m of body.matchAll(re)) {
        const n = Number(m[1]);
        if (!Number.isNaN(n))
            nums.push(n);
    }
    return nums;
}
// Find the open PR for a given branch name. Convention: branch is afk/issue-N.
export async function findOpenPrForBranch(branch) {
    const out = await execa(config.ghBin, [
        "pr", "list",
        "--repo", config.repo,
        "--head", branch,
        "--state", "open",
        "--json", "number,url,state",
    ], { reject: false });
    if (out.exitCode !== 0)
        return null;
    try {
        const arr = JSON.parse(out.stdout);
        return arr[0] ?? null;
    }
    catch {
        return null;
    }
}
// Pull every PR review (with body), every inline review comment, and every
// issue-comment on the PR. Returned sorted chronologically — the order an
// implementer should address them.
export async function listPrFeedback(prNumber) {
    const out = [];
    // Reviews + their inline review comments
    const r = await execa(config.ghBin, [
        "pr", "view", String(prNumber),
        "--repo", config.repo,
        "--json", "reviews,comments",
    ], { reject: false });
    if (r.exitCode === 0) {
        try {
            // gh returns `submittedAt` for reviews and `createdAt` for issue-style
            // comments. We normalise both to `createdAt` on the way out so the
            // caller can sort by one field. Falls back to epoch-string if neither
            // is present (defensive — undefined here used to crash the rework loop).
            const data = JSON.parse(r.stdout);
            const epoch = "1970-01-01T00:00:00Z";
            for (const rev of data.reviews ?? []) {
                if (rev.body && rev.body.trim().length > 0) {
                    out.push({
                        author: rev.author?.login ?? "(unknown)",
                        body: rev.body,
                        createdAt: rev.submittedAt ?? rev.createdAt ?? epoch,
                        kind: "review",
                        state: rev.state,
                    });
                }
            }
            for (const c of data.comments ?? []) {
                out.push({
                    author: c.author?.login ?? "(unknown)",
                    body: c.body,
                    createdAt: c.createdAt ?? epoch,
                    kind: "issue-comment",
                });
            }
        }
        catch {
            /* ignore */
        }
    }
    // Inline review comments (`gh pr view --json` doesn't include these; use the API)
    const inline = await execa(config.ghBin, [
        "api", `repos/${config.repo}/pulls/${prNumber}/comments`, "--paginate",
    ], { reject: false });
    if (inline.exitCode === 0) {
        try {
            const arr = JSON.parse(inline.stdout);
            for (const c of arr) {
                out.push({
                    author: c.user?.login ?? "(unknown)",
                    body: c.body,
                    createdAt: c.created_at ?? "1970-01-01T00:00:00Z",
                    kind: "review-comment",
                    path: c.path,
                    line: c.line,
                });
            }
        }
        catch {
            /* ignore */
        }
    }
    // Defensive sort: any entry without a parseable createdAt sorts oldest-first.
    // Previously a missing field threw on `.localeCompare(undefined)` and broke
    // the entire rework loop silently.
    return out.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}
// Read the attempt count off an issue. Convention: a label `afk-attempts-N`.
// Returns 0 if no attempts label is present.
export function getAttemptCount(issue) {
    for (const l of issue.labels) {
        const m = l.name.match(/^afk-attempts-(\d+)$/);
        if (m && m[1])
            return Number(m[1]);
    }
    return 0;
}
// Increment the attempt count label on an issue. Returns the new count.
// Idempotent enough: removes any existing attempt label before adding the new one.
export async function bumpAttemptCount(issue) {
    const current = getAttemptCount(issue);
    const next = current + 1;
    // Remove any stale attempts label (covers up to 9 — enough for any sane cap)
    for (let i = 1; i <= 9; i++) {
        if (i === next)
            continue;
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
export async function clearAttemptCount(issueNumber) {
    for (let i = 1; i <= 9; i++) {
        await execa(config.ghBin, [
            "issue", "edit", String(issueNumber),
            "--repo", config.repo,
            "--remove-label", `afk-attempts-${i}`,
        ], { reject: false });
    }
}
