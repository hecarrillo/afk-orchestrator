// `afk bootstrap` — wire a fresh worktree to a base repo via symlinks instead
// of copying gigabytes of node_modules into every workspace.
//
// Reads the `bootstrap` block of afk.config.json:
//
//   "bootstrap": {
//     "base": "$HOME/ra/v2",            // optional — auto-detected if omitted
//     "linkPaths": ["node_modules", ".env", "telerik-license.txt"]
//   }
//
// When `base` is omitted, it's derived from the current worktree's git
// metadata: `git rev-parse --git-common-dir` returns the shared `.git`
// directory; its parent is the base repo's working tree. This means a
// committed `afk.config.json` can be reused across every developer's machine
// without per-checkout path edits.

import { execSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, readdirSync, rmSync, unlinkSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { config } from "./config.ts";

const REAL_INSTALL_THRESHOLD = 20;

export function bootstrap(): number {
  const bs = config.bootstrap;
  if (!bs) {
    process.stderr.write(
      `no \`bootstrap\` block in ${config.configPath}.\n` +
      `Add one to enable \`afk bootstrap\`:\n` +
      `  "bootstrap": { "linkPaths": ["node_modules", ".env"] }\n` +
      `(\`base\` is optional — auto-detected from worktree metadata when omitted.)\n`
    );
    return 2;
  }

  const work = process.cwd();

  let base: string;
  try {
    const baseRaw = bs.base ?? autoDetectBase(work);
    base = resolve(expandHome(baseRaw));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `error: could not determine bootstrap base.\n` +
      `${msg}\n` +
      `Either run from inside a git worktree, or set \`bootstrap.base\` in ${config.configPath}.\n`
    );
    return 1;
  }

  if (!existsSync(base)) {
    process.stderr.write(`error: base repo not found at ${base}\n`);
    return 1;
  }
  if (work === base) {
    process.stderr.write(`error: refusing to bootstrap the base repo into itself\n`);
    return 1;
  }

  process.stdout.write(`bootstrapping ${work}\n  base: ${base}${bs.base ? "" : " (auto-detected)"}\n`);

  let hadFailure = false;
  for (const rel of bs.linkPaths) {
    if (!linkFromBase(base, work, rel)) hadFailure = true;
  }

  process.stdout.write(hadFailure ? "done (with warnings)\n" : "done\n");
  return hadFailure ? 1 : 0;
}

/**
 * Derive the base repo's working tree from the current worktree's git metadata.
 *
 * In a worktree, `<cwd>/.git` is a *file* containing `gitdir: <base>/.git/worktrees/<name>`.
 * `git rev-parse --git-common-dir` returns the shared `.git` directory (`<base>/.git`),
 * and its parent is the base working tree. In a non-worktree clone, this returns the
 * repo root itself (which is the right answer when `afk bootstrap` is run from the
 * base — `bootstrap()` already refuses to bootstrap a base into itself).
 *
 * Throws if `workDir` is not inside any git repo, or if `git` is not on PATH.
 */
export function autoDetectBase(workDir: string): string {
  let out: string;
  try {
    out = execSync("git rev-parse --git-common-dir", {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    throw new Error(`not a git repo (or git not on PATH): ${stderr.trim() || (err as Error).message}`);
  }
  const commonDir = isAbsolute(out) ? out : resolve(workDir, out);
  return dirname(commonDir);
}

function linkFromBase(base: string, work: string, rel: string): boolean {
  const src = join(base, rel);
  const dst = join(work, rel);

  if (!existsSync(src) && !isSymlink(src)) {
    return true; // nothing in base, nothing to link
  }

  if (isSymlink(dst)) {
    if (readlinkSync(dst) === src) {
      process.stdout.write(`  ${rel}: already linked\n`);
      return true;
    }
    unlinkSync(dst);
  } else if (existsSync(dst) && lstatSync(dst).isDirectory()) {
    const entryCount = readdirSync(dst).length;
    if (entryCount > REAL_INSTALL_THRESHOLD) {
      process.stderr.write(`  ${rel}: ${entryCount} entries — looks like a real install, skipping. Remove manually if intentional.\n`);
      return false;
    }
    rmSync(dst, { recursive: true, force: true });
  } else if (existsSync(dst)) {
    process.stdout.write(`  ${rel}: leaving existing file in place (not a stub)\n`);
    return true;
  }

  symlinkSync(src, dst);
  process.stdout.write(`  ${rel}: linked -> ${src}\n`);
  return true;
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function expandHome(p: string): string {
  if (p.startsWith("~")) return p.replace(/^~/, process.env.HOME ?? "");
  if (p.startsWith("$HOME")) return p.replace(/^\$HOME/, process.env.HOME ?? "");
  return p;
}
