// Print a one-screen "brief" for a given issue or PR: original issue context
// + PR summary (commits, files, status) + the automated reviewer's full report.
//
// Designed for two uses:
//   1. Standalone: `npm run afk:brief 18` before/during human QA.
//   2. Embedded: called from inside `afk:qa` so the user sees the full context
//      automatically before every prompt.
import { execa } from "execa";
import { config } from "./config.js";
import { getIssue } from "./gh.js";
const bold = "\x1b[1m", dim = "\x1b[2m", green = "\x1b[32m", yellow = "\x1b[33m", red = "\x1b[31m", cyan = "\x1b[36m", reset = "\x1b[0m";
const hr = "─".repeat(72);
/// Print brief for whatever number was given (try as PR first, then as issue).
/// If both succeed, prints the unified view.
export async function brief(numberArg) {
    const [issue, pr] = await resolve(numberArg);
    if (!issue && !pr) {
        process.stdout.write(`${red}Could not find issue or PR #${numberArg} in ${config.repo}.${reset}\n`);
        return;
    }
    printUnified(issue, pr);
}
/// Print briefs for everything currently awaiting human QA. Useful entry point
/// when starting a QA session.
export async function briefAllAwaitingQa() {
    const { listOpenIssuesByLabel } = await import("./gh.js");
    const { labels } = await import("./labels.js");
    const pending = await listOpenIssuesByLabel(labels.needsHumanQa);
    if (pending.length === 0) {
        process.stdout.write(`Nothing awaiting human QA.\n`);
        return;
    }
    process.stdout.write(`${bold}${pending.length} item(s) awaiting human QA:${reset}\n\n`);
    for (const issue of pending) {
        const pr = await prForBranch(`${config.branchPrefix}issue-${issue.number}`);
        printUnified(issue, pr);
        process.stdout.write(`\n${hr}\n\n`);
    }
}
async function resolve(num) {
    // Try as a PR first (more specific).
    const prDirect = await fetchPr(num).catch(() => null);
    if (prDirect) {
        const issueNum = parseLinkedIssue(prDirect);
        const issue = issueNum ? await getIssue(issueNum).catch(() => null) : null;
        return [issue, prDirect];
    }
    // Try as an issue, then find the linked PR via branch convention.
    const issue = await getIssue(num).catch(() => null);
    if (!issue)
        return [null, null];
    const pr = await prForBranch(`${config.branchPrefix}issue-${num}`);
    return [issue, pr];
}
async function fetchPr(num) {
    const r = await execa(config.ghBin, [
        "pr", "view", String(num),
        "--repo", config.repo,
        "--json", "number,title,url,state,body,headRefName,commits,files,reviews",
    ], { reject: false });
    if (r.exitCode !== 0)
        return null;
    return JSON.parse(r.stdout);
}
async function prForBranch(branch) {
    const list = await execa(config.ghBin, [
        "pr", "list",
        "--repo", config.repo,
        "--head", branch,
        "--state", "all",
        "--json", "number",
    ], { reject: false });
    if (list.exitCode !== 0)
        return null;
    try {
        const arr = JSON.parse(list.stdout);
        if (arr.length === 0 || !arr[0])
            return null;
        return await fetchPr(arr[0].number);
    }
    catch {
        return null;
    }
}
function parseLinkedIssue(pr) {
    // Branch convention: afk/issue-N
    const branchMatch = pr.headRefName.match(/issue-(\d+)/);
    if (branchMatch && branchMatch[1])
        return Number(branchMatch[1]);
    // PR body: "closes #N" / "resolves #N" (case-insensitive)
    const bodyMatch = pr.body.match(/(?:closes|resolves|fixes)\s+#(\d+)/i);
    if (bodyMatch && bodyMatch[1])
        return Number(bodyMatch[1]);
    return null;
}
function printUnified(issue, pr) {
    // ── ISSUE ─────────────────────────────────────────────────────────────
    if (issue) {
        const hitl = issue.labels.some(l => l.name === "hitl") ? ` ${yellow}[HITL]${reset}` : "";
        process.stdout.write(`${bold}${cyan}ISSUE #${issue.number}${reset}${hitl}  ${bold}${issue.title}${reset}\n`);
        process.stdout.write(`${dim}${issue.url}${reset}\n`);
        const acLines = extractSection(issue.body, "Acceptance criteria");
        if (acLines.length > 0) {
            process.stdout.write(`\n${bold}Acceptance criteria:${reset}\n`);
            for (const line of acLines)
                process.stdout.write(`  ${line}\n`);
        }
        const whatLines = extractSection(issue.body, "What to build");
        if (whatLines.length > 0) {
            process.stdout.write(`\n${bold}What to build:${reset}\n`);
            for (const line of whatLines.slice(0, 30))
                process.stdout.write(`  ${line}\n`);
            if (whatLines.length > 30)
                process.stdout.write(`  ${dim}... (${whatLines.length - 30} more lines — \`gh issue view ${issue.number}\` for full)${reset}\n`);
        }
    }
    else {
        process.stdout.write(`${dim}(no linked issue found)${reset}\n`);
    }
    // ── PR ────────────────────────────────────────────────────────────────
    if (pr) {
        process.stdout.write(`\n${bold}${cyan}PR #${pr.number}${reset}  ${bold}${pr.title}${reset}\n`);
        const stateColor = pr.state === "MERGED" ? green : pr.state === "CLOSED" ? red : yellow;
        process.stdout.write(`${dim}${pr.url}${reset}  ${stateColor}${pr.state}${reset}\n`);
        const totalAdd = pr.files.reduce((s, f) => s + f.additions, 0);
        const totalDel = pr.files.reduce((s, f) => s + f.deletions, 0);
        process.stdout.write(`\n${bold}${pr.commits.length} commit(s), ${pr.files.length} file(s) ${green}+${totalAdd}${reset}/${red}-${totalDel}${reset}\n`);
        for (const c of pr.commits) {
            process.stdout.write(`  ${dim}${c.oid.slice(0, 7)}${reset}  ${c.messageHeadline}\n`);
        }
        if (pr.files.length > 0 && pr.files.length <= 25) {
            process.stdout.write(`\n${bold}Files:${reset}\n`);
            for (const f of pr.files) {
                process.stdout.write(`  ${green}+${f.additions}${reset}/${red}-${f.deletions}${reset}  ${f.path}\n`);
            }
        }
        else if (pr.files.length > 25) {
            process.stdout.write(`\n${dim}(${pr.files.length} files — run \`gh pr diff ${pr.number} --name-only\` for the full list)${reset}\n`);
        }
    }
    else if (issue) {
        process.stdout.write(`\n${dim}(no PR linked to this issue yet)${reset}\n`);
    }
    // ── REVIEWER REPORT ───────────────────────────────────────────────────
    const reviewerReport = extractReviewerReport(pr);
    if (reviewerReport) {
        process.stdout.write(`\n${bold}${cyan}AUTOMATED REVIEWER REPORT${reset}\n`);
        process.stdout.write(`${reviewerReport}\n`);
    }
}
function extractReviewerReport(pr) {
    if (!pr)
        return null;
    // The orchestrator includes the reviewer report inside the PR body under
    // a "## Reviewer report (automated)" heading. Find it and trim.
    const idx = pr.body.indexOf("## Reviewer report (automated)");
    if (idx < 0) {
        // Fall back to checking PR reviews (the comment we post via gh pr review --comment)
        const fromReviews = pr.reviews?.find(r => r.body.includes("AFK reviewer verdict"));
        return fromReviews ? fromReviews.body : null;
    }
    const tail = pr.body.slice(idx + "## Reviewer report (automated)".length);
    const cutoff = tail.indexOf("\n---");
    return (cutoff >= 0 ? tail.slice(0, cutoff) : tail).trim();
}
function extractSection(body, heading) {
    const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*$`, "im");
    const lines = body.split("\n");
    const startIdx = lines.findIndex(l => re.test(l));
    if (startIdx < 0)
        return [];
    const out = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined)
            break;
        if (/^##\s/.test(line))
            break;
        out.push(line);
    }
    // Strip leading/trailing blank lines
    while (out.length > 0 && out[0]?.trim() === "")
        out.shift();
    while (out.length > 0 && out[out.length - 1]?.trim() === "")
        out.pop();
    return out;
}
