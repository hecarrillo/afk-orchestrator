// `afk bootstrap` — wire a fresh worktree to a base repo via symlinks instead
// of copying gigabytes of node_modules into every workspace.
//
// Modeled directly on Hector's conductor-bootstrap script. Reads the
// `bootstrap` block of afk.config.json:
//
//   "bootstrap": {
//     "base": "$HOME/ra/v2",
//     "linkPaths": ["node_modules", ".env", "telerik-license.txt"]
//   }
//
// Run from inside a worktree. Idempotent: re-running on a properly-bootstrapped
// workspace is a no-op. Safe: refuses to remove a node_modules-like directory
// that looks like a real install (>20 entries).
import { existsSync, lstatSync, readlinkSync, readdirSync, rmSync, unlinkSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.js";
const REAL_INSTALL_THRESHOLD = 20;
export function bootstrap() {
    const bs = config.bootstrap;
    if (!bs) {
        process.stderr.write(`no \`bootstrap\` block in ${config.configPath}.\n` +
            `Add one to enable \`afk bootstrap\`:\n` +
            `  "bootstrap": { "base": "$HOME/ra/v2", "linkPaths": ["node_modules", ".env"] }\n`);
        return 2;
    }
    const base = resolve(expandHome(bs.base));
    const work = process.cwd();
    if (!existsSync(base)) {
        process.stderr.write(`error: base repo not found at ${base}\n`);
        return 1;
    }
    if (work === base) {
        process.stderr.write(`error: refusing to bootstrap the base repo into itself\n`);
        return 1;
    }
    process.stdout.write(`bootstrapping ${work}\n  base: ${base}\n`);
    let hadFailure = false;
    for (const rel of bs.linkPaths) {
        if (!linkFromBase(base, work, rel))
            hadFailure = true;
    }
    process.stdout.write(hadFailure ? "done (with warnings)\n" : "done\n");
    return hadFailure ? 1 : 0;
}
function linkFromBase(base, work, rel) {
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
    }
    else if (existsSync(dst) && lstatSync(dst).isDirectory()) {
        const entryCount = readdirSync(dst).length;
        if (entryCount > REAL_INSTALL_THRESHOLD) {
            process.stderr.write(`  ${rel}: ${entryCount} entries — looks like a real install, skipping. Remove manually if intentional.\n`);
            return false;
        }
        rmSync(dst, { recursive: true, force: true });
    }
    else if (existsSync(dst)) {
        process.stdout.write(`  ${rel}: leaving existing file in place (not a stub)\n`);
        return true;
    }
    symlinkSync(src, dst);
    process.stdout.write(`  ${rel}: linked -> ${src}\n`);
    return true;
}
function isSymlink(p) {
    try {
        return lstatSync(p).isSymbolicLink();
    }
    catch {
        return false;
    }
}
function expandHome(p) {
    if (p.startsWith("~"))
        return p.replace(/^~/, process.env.HOME ?? "");
    if (p.startsWith("$HOME"))
        return p.replace(/^\$HOME/, process.env.HOME ?? "");
    return p;
}
