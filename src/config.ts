// Config for the AFK orchestrator. Loaded from `afk.config.json` in the
// nearest ancestor of the current working directory. Env vars override JSON
// fields, so secrets and per-machine tweaks stay out of git.
//
// Required fields:
//   repo         — "owner/name" for gh CLI
//
// Optional fields, with defaults:
//   baseBranch          = "main"
//   branchPrefix        = "afk/"
//   worktreesRoot       = "../.afk-worktrees-<repo-dir-name>" (sibling of repo)
//   concurrency         = 3
//   maxRounds           = 5
//   maxWallClockMs      = 14_400_000          (4 h)
//   implementerTimeoutMs = 1_800_000          (30 min)
//   reviewerTimeoutMs    = 600_000            (10 min)
//   maxAttempts         = 3
//   claudeBin           = "claude"
//   ghBin               = "gh"
//   postCreateWorktree  — shell command to run after `git worktree add`
//   bootstrap           — see `afk bootstrap` for the schema
//   notifications.telegram — { chatId } when AFK_TELEGRAM_BOT_TOKEN is set
//   dashboard           — { port?: number, host?: string }

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";

export interface AfkConfig {
  repo: string;
  baseBranch: string;
  branchPrefix: string;
  worktreesRoot: string;
  concurrency: number;
  maxRounds: number;
  maxWallClockMs: number;
  implementerTimeoutMs: number;
  reviewerTimeoutMs: number;
  maxAttempts: number;
  claudeBin: string;
  ghBin: string;
  postCreateWorktree?: string;
  bootstrap?: {
    base: string;
    linkPaths: string[];
  };
  notifications?: {
    telegram?: {
      chatId: string;
    };
  };
  dashboard?: {
    port?: number;
    host?: string;
  };
  // Resolved at load time.
  repoRoot: string;
  configPath: string;
}

const CONFIG_FILENAMES = ["afk.config.json"];

function findConfigUpwards(start: string): { path: string; raw: Partial<AfkConfig> } | null {
  let dir = start;
  while (dir !== "/") {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        const raw = JSON.parse(readFileSync(candidate, "utf8")) as Partial<AfkConfig>;
        return { path: candidate, raw };
      }
    }
    dir = dirname(dir);
  }
  return null;
}

function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== "/") {
    if (existsSync(join(dir, ".git"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`no .git found walking up from ${start}`);
}

function loadConfig(): AfkConfig {
  const cwd = process.cwd();
  const repoRoot = findRepoRoot(cwd);
  const found = findConfigUpwards(cwd);

  if (!found && !process.env.AFK_REPO) {
    throw new Error(
      `no afk.config.json found in ${cwd} or any parent, and AFK_REPO is not set.\n` +
      `Create an afk.config.json at the project root with at minimum: { "repo": "owner/name" }`,
    );
  }

  const raw = found?.raw ?? {};
  const repo = process.env.AFK_REPO ?? raw.repo;
  if (!repo) {
    throw new Error(`afk.config.json is missing required field "repo" (e.g. "hecarrillo/r2m")`);
  }

  const repoDirName = basename(repoRoot);
  return {
    repo,
    baseBranch: process.env.AFK_BASE_BRANCH ?? raw.baseBranch ?? "main",
    branchPrefix: raw.branchPrefix ?? "afk/",
    worktreesRoot:
      raw.worktreesRoot
        ? resolve(repoRoot, raw.worktreesRoot)
        : resolve(repoRoot, "..", `.afk-worktrees-${repoDirName}`),
    concurrency: Number(process.env.AFK_CONCURRENCY ?? raw.concurrency ?? 3),
    maxRounds: Number(process.env.AFK_MAX_ROUNDS ?? raw.maxRounds ?? 5),
    maxWallClockMs: Number(process.env.AFK_MAX_WALLCLOCK_MS ?? raw.maxWallClockMs ?? 4 * 60 * 60 * 1000),
    implementerTimeoutMs: Number(process.env.AFK_IMPL_TIMEOUT_MS ?? raw.implementerTimeoutMs ?? 30 * 60 * 1000),
    reviewerTimeoutMs: Number(process.env.AFK_REVIEW_TIMEOUT_MS ?? raw.reviewerTimeoutMs ?? 10 * 60 * 1000),
    maxAttempts: Number(process.env.AFK_MAX_ATTEMPTS ?? raw.maxAttempts ?? 3),
    claudeBin: process.env.AFK_CLAUDE_BIN ?? raw.claudeBin ?? "claude",
    ghBin: process.env.AFK_GH_BIN ?? raw.ghBin ?? "gh",
    postCreateWorktree: raw.postCreateWorktree,
    bootstrap: raw.bootstrap,
    notifications: raw.notifications,
    dashboard: raw.dashboard,
    repoRoot,
    configPath: found?.path ?? "(env-only)",
  };
}

export const config: AfkConfig = loadConfig();
