// `afk status` — one-shot snapshot of orchestrator state.

import { execa } from "execa";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { afkManagedLabels, labels } from "./labels.ts";
import { listOpenIssuesByLabel, type Issue } from "./gh.ts";

const bold = "\x1b[1m", dim = "\x1b[2m", green = "\x1b[32m", yellow = "\x1b[33m", red = "\x1b[31m", reset = "\x1b[0m";

export async function runStatus(): Promise<void> {
  const seen = new Map<number, Issue>();
  for (const lbl of [...afkManagedLabels, labels.prdReady]) {
    for (const i of await listOpenIssuesByLabel(lbl)) {
      if (!seen.has(i.number)) seen.set(i.number, i);
    }
  }
  const all = [...seen.values()].sort((a, b) => a.number - b.number);
  const inProgress = all.filter(i => i.labels.some(l => l.name === labels.inProgress));
  const needsReview = all.filter(i => i.labels.some(l => l.name === labels.needsReview));
  const needsQa = all.filter(i => i.labels.some(l => l.name === labels.needsHumanQa));
  const needsChanges = all.filter(i => i.labels.some(l => l.name === labels.needsChanges));
  const ready = all.filter(i =>
    i.labels.some(l => l.name === labels.prdReady) &&
    !i.labels.some(l => (afkManagedLabels as readonly string[]).includes(l.name)),
  );

  process.stdout.write(`${bold}AFK status${reset}  ${dim}${new Date().toLocaleString()} · ${config.repo}${reset}\n`);
  process.stdout.write(`${dim}${"─".repeat(72)}${reset}\n`);

  await section(`In progress (${inProgress.length})`, inProgress, true);
  await section(`Awaiting reviewer (${needsReview.length})`, needsReview, true);
  await section(`Awaiting human QA (${needsQa.length})`, needsQa, false, true);
  await section(`Needs changes — auto-rework next round (${needsChanges.length})`, needsChanges, false, true);
  await section(`Ready for next round (${ready.length})`, ready, false);

  const ps = await execa("pgrep", ["-fl", "afk (plan|loop|qa|dashboard)"], { reject: false });
  if (ps.stdout.trim()) {
    process.stdout.write(`\n${bold}Live orchestrator processes:${reset}\n`);
    for (const line of ps.stdout.trim().split("\n")) {
      process.stdout.write(`  ${dim}${line.slice(0, 100)}${line.length > 100 ? "…" : ""}${reset}\n`);
    }
  } else {
    process.stdout.write(`\n${dim}No live orchestrator processes.${reset}\n`);
  }
}

async function section(title: string, issues: Issue[], showWorktree: boolean, showPr = false): Promise<void> {
  if (issues.length === 0) return;
  process.stdout.write(`\n${bold}${title}${reset}\n`);
  for (const i of issues) {
    const hitl = i.labels.some(l => l.name === "hitl") ? ` ${yellow}[HITL]${reset}` : "";
    const attemptLabel = i.labels.map(l => l.name).find(n => /^afk-attempts-\d+$/.test(n));
    const attempts = attemptLabel ? ` ${dim}(attempt ${attemptLabel.replace("afk-attempts-", "")})${reset}` : "";
    process.stdout.write(`  #${i.number}${hitl}${attempts}  ${truncate(i.title, 60)}\n`);
    if (showWorktree) {
      const wtPath = join(config.worktreesRoot, `issue-${i.number}`);
      if (existsSync(wtPath)) {
        const commits = await commitCount(wtPath);
        const dirty = await dirtyStatus(wtPath);
        const dot = commits === 0 ? red : green;
        process.stdout.write(`     ${dot}● ${commits} commit(s)${reset}${dirty ? ` ${dim}(uncommitted: ${dirty})${reset}` : ""}  ${dim}${wtPath}${reset}\n`);
      } else {
        process.stdout.write(`     ${dim}(no worktree)${reset}\n`);
      }
    }
    if (showPr) {
      const pr = await findPrUrl(`${config.branchPrefix}issue-${i.number}`);
      if (pr) process.stdout.write(`     ${green}→ ${pr}${reset}\n`);
    }
  }
}

async function commitCount(wt: string): Promise<number> {
  const baseRef = await currentBaseRef();
  const r = await execa("git", ["-C", wt, "rev-list", "--count", `${baseRef}..HEAD`], { reject: false });
  return r.exitCode === 0 ? Number(r.stdout.trim()) : 0;
}

async function dirtyStatus(wt: string): Promise<string> {
  const r = await execa("git", ["-C", wt, "status", "--porcelain"], { reject: false });
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  return lines.length > 0 ? `${lines.length} file(s)` : "";
}

async function findPrUrl(branch: string): Promise<string | null> {
  const r = await execa(config.ghBin, [
    "pr", "list", "--repo", config.repo,
    "--head", branch, "--state", "open",
    "--json", "url",
  ], { reject: false });
  if (r.exitCode !== 0) return null;
  try {
    const arr = JSON.parse(r.stdout) as { url: string }[];
    return arr.length > 0 && arr[0] ? arr[0].url : null;
  } catch {
    return null;
  }
}

async function currentBaseRef(): Promise<string> {
  const probe = await execa("git", ["-C", config.repoRoot, "rev-parse", "--verify", `origin/${config.baseBranch}`], { reject: false });
  return probe.exitCode === 0 ? `origin/${config.baseBranch}` : config.baseBranch;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
