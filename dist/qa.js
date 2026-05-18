// Day-shift QA companion. Lists every issue currently in `afk-needs-qa` and
// walks the user through them one at a time. For each: prints PR URL, runs
// the project's build/tests, opens the diff (gh pr diff), and prompts the
// user to (a) approve and merge, (b) request changes (drops it back to
// afk-needs-changes for the next planner round), or (c) skip for now.
//
// Stays intentionally low-magic: this is a *guided* manual flow, not an
// auto-QA. The whole point is the human is in the loop.
import { execa } from "execa";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { listOpenIssuesByLabel, addLabels, removeLabels, reviewPullRequest, clearAttemptCount } from "./gh.js";
import { labels, afkManagedLabels } from "./labels.js";
import { config } from "./config.js";
import { brief } from "./brief.js";
export async function qa() {
    const pending = await listOpenIssuesByLabel(labels.needsHumanQa);
    if (pending.length === 0) {
        process.stdout.write("Nothing awaiting human QA. Get a coffee.\n");
        return;
    }
    process.stdout.write(`${pending.length} issue(s) awaiting QA.\n\n`);
    const rl = createInterface({ input, output });
    try {
        for (const issue of pending) {
            process.stdout.write(`\n${"═".repeat(72)}\n\n`);
            // Print the full brief (issue body + PR summary + reviewer report) so the
            // user has all context inline without remembering each specific ticket.
            await brief(issue.number);
            const branch = `${config.branchPrefix}issue-${issue.number}`;
            const prUrl = await findPrForBranch(branch).catch(() => null);
            process.stdout.write(`\n`);
            const answer = (await rl.question("[o] open in browser  [d] full diff  [a] approve  [r] request changes  [s] skip  [q] quit > ")).trim().toLowerCase();
            if (answer === "q")
                return;
            if (answer === "o" && prUrl) {
                await execa("open", [prUrl], { reject: false });
                // re-prompt
                const a2 = (await rl.question("[a] approve  [r] request changes  [s] skip > ")).trim().toLowerCase();
                await handleVerdict(issue.number, prUrl, a2, rl);
                continue;
            }
            if (answer === "d" && prUrl) {
                const prNumber = parsePrNumber(prUrl);
                if (prNumber !== null) {
                    await execa(config.ghBin, ["pr", "diff", String(prNumber), "--repo", config.repo], { stdio: "inherit", reject: false });
                }
                const a2 = (await rl.question("[a] approve  [r] request changes  [s] skip > ")).trim().toLowerCase();
                await handleVerdict(issue.number, prUrl, a2, rl);
                continue;
            }
            await handleVerdict(issue.number, prUrl, answer, rl);
        }
    }
    finally {
        rl.close();
    }
}
async function handleVerdict(issueNumber, prUrl, verdict, rl) {
    if (verdict === "a") {
        if (!prUrl) {
            process.stdout.write("No PR to merge.\n");
            return;
        }
        const prNumber = parsePrNumber(prUrl);
        if (prNumber === null)
            return;
        const r = await execa(config.ghBin, ["pr", "merge", String(prNumber), "--repo", config.repo, "--squash", "--delete-branch"], { stdio: "inherit", reject: false });
        if (r.exitCode === 0) {
            // Clear all AFK state on the issue — GitHub auto-closes via "Resolves #N",
            // but the labels persist on closed issues unless we strip them.
            await removeLabels(issueNumber, [...afkManagedLabels]).catch(() => { });
            await clearAttemptCount(issueNumber).catch(() => { });
            process.stdout.write(`✓ merged.\n`);
        }
        else {
            process.stdout.write(`✗ merge failed (see above).\n`);
        }
        return;
    }
    if (verdict === "r") {
        if (!prUrl) {
            process.stdout.write("No PR to leave feedback on.\n");
            return;
        }
        const prNumber = parsePrNumber(prUrl);
        if (prNumber === null)
            return;
        process.stdout.write("What needs to change? (will be posted as a PR review and re-dispatched next planner round)\n");
        process.stdout.write("End with a single '.' on its own line.\n");
        const lines = [];
        while (true) {
            const line = await rl.question("> ");
            if (line.trim() === ".")
                break;
            lines.push(line);
        }
        const note = lines.join("\n").trim();
        if (!note) {
            process.stdout.write(`(empty — skipping)\n`);
            return;
        }
        const reviewBody = `**Human QA — requesting changes**\n\n${note}`;
        // Try `--request-changes` first; fall back to `--comment` when GitHub
        // blocks self-review-on-own-PR (common for solo-developer repos).
        const req = await reviewPullRequest({ prNumber, verdict: "request-changes", body: reviewBody }).catch(() => null);
        if (req === null) {
            await reviewPullRequest({ prNumber, verdict: "comment", body: reviewBody }).catch(err => {
                process.stderr.write(`couldn't post PR review: ${err instanceof Error ? err.message : String(err)}\n`);
            });
        }
        await removeLabels(issueNumber, [labels.needsHumanQa]);
        await addLabels(issueNumber, [labels.needsChanges]);
        process.stdout.write(`✓ feedback posted to PR; planner will auto-dispatch a rework on the next round.\n`);
        return;
    }
    if (verdict === "s") {
        process.stdout.write(`⏭  skipped.\n`);
        return;
    }
    process.stdout.write(`(unrecognised input; skipping)\n`);
}
async function findPrForBranch(branch) {
    const result = await execa(config.ghBin, [
        "pr", "list",
        "--repo", config.repo,
        "--head", branch,
        "--state", "open",
        "--json", "url",
    ], { reject: false });
    if (result.exitCode !== 0)
        return null;
    try {
        const arr = JSON.parse(result.stdout);
        return arr.length > 0 && arr[0] ? arr[0].url : null;
    }
    catch {
        return null;
    }
}
function parsePrNumber(url) {
    const m = url.match(/\/pull\/(\d+)/);
    return m && m[1] ? Number(m[1]) : null;
}
