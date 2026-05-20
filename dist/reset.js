// `afk reset --issue N` — emergency cleanup. Removes a stale worktree, strips
// AFK-managed labels AND attempt counters from the issue, and leaves it in
// `ready-for-agent` state for re-dispatch on the next planner round. Clearing
// `afk-attempts-N` matters when reset is invoked after a partial-progress
// dispatch — otherwise the issue could hit the attempt cap on its very next
// retry even though we're explicitly starting it over.
import { join } from "node:path";
import { removeWorktree } from "./worktree.js";
import { addLabels, removeLabels, clearAttemptCount } from "./gh.js";
import { afkManagedLabels, labels } from "./labels.js";
import { config } from "./config.js";
export async function resetIssue(issueNumber) {
    if (Number.isNaN(issueNumber) || issueNumber <= 0) {
        process.stderr.write(`invalid issue number: ${issueNumber}\n`);
        process.exit(2);
    }
    const branch = `${config.branchPrefix}issue-${issueNumber}`;
    const path = join(config.worktreesRoot, `issue-${issueNumber}`);
    await removeWorktree({ branch, path });
    await removeLabels(issueNumber, [...afkManagedLabels]).catch(() => { });
    await clearAttemptCount(issueNumber).catch(() => { });
    await addLabels(issueNumber, [labels.prdReady]).catch(() => { });
    process.stdout.write(`reset #${issueNumber}: worktree removed, attempts cleared, labels reset to ${labels.prdReady}\n`);
}
