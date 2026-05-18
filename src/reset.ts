// `afk reset --issue N` — emergency cleanup. Removes a stale worktree and
// strips AFK-managed labels from the issue, leaving it in `ready-for-agent`
// state for re-dispatch on the next planner round.

import { join } from "node:path";
import { removeWorktree } from "./worktree.ts";
import { addLabels, removeLabels } from "./gh.ts";
import { afkManagedLabels, labels } from "./labels.ts";
import { config } from "./config.ts";

export async function resetIssue(issueNumber: number): Promise<void> {
  if (Number.isNaN(issueNumber) || issueNumber <= 0) {
    process.stderr.write(`invalid issue number: ${issueNumber}\n`);
    process.exit(2);
  }

  const branch = `${config.branchPrefix}issue-${issueNumber}`;
  const path = join(config.worktreesRoot, `issue-${issueNumber}`);
  await removeWorktree({ branch, path });
  await removeLabels(issueNumber, [...afkManagedLabels]).catch(() => {});
  await addLabels(issueNumber, [labels.prdReady]).catch(() => {});
  process.stdout.write(`reset #${issueNumber}: worktree removed, labels reset to ${labels.prdReady}\n`);
}
