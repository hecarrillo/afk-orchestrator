#!/usr/bin/env node
// Single bin entrypoint — `afk <subcommand>`. Dispatches to the right module.
import { plan } from "./planner.js";
import { dispatch } from "./dispatcher.js";
import { loop } from "./loop.js";
import { qa } from "./qa.js";
import { brief, briefAllAwaitingQa } from "./brief.js";
import { bootstrap } from "./bootstrap.js";
import { startDashboard } from "./dashboard/server.js";
import { test as telegramTest } from "./subscribers/telegram.js";
const HELP = `afk — local agent orchestrator

Usage: afk <subcommand> [...args]

Workflow commands:
  plan                          Dry-run the planner; --dispatch to fire one round
  loop                          Bounded multi-round driver (night-shift mode)
  qa                            Day-shift companion: walk PRs awaiting human QA

Inspection:
  status                        One-shot snapshot of orchestrator state
  brief [N]                     Issue + PR + reviewer report for #N (or all awaiting QA)
  dashboard                     Per-project ephemeral web UI (Mermaid DAG, live updates)

Project setup:
  bootstrap                     Wire fresh worktree to a base repo via symlinks
  telegram-test                 Send a test message to the configured Telegram chat

Maintenance:
  reset --issue N               Emergency cleanup: remove worktree + reset labels

Configuration:
  Reads afk.config.json from the cwd or nearest ancestor.
  See https://github.com/hecarrillo/afk-orchestrator#configuration for the schema.
`;
async function main() {
    const [, , subcommand, ...rest] = process.argv;
    switch (subcommand) {
        case undefined:
        case "-h":
        case "--help":
        case "help":
            process.stdout.write(HELP);
            return;
        case "plan": {
            const shouldDispatch = rest.includes("--dispatch");
            const result = await plan();
            printPlan(result, shouldDispatch);
            if (!shouldDispatch || result.ready.length === 0)
                return;
            await dispatchReady(result.ready);
            return;
        }
        case "loop": {
            const summary = await loop();
            process.stdout.write(`\n=== loop done (${summary.reason}) ===\n` +
                `rounds=${summary.rounds} dispatched=${summary.totalDispatched} ` +
                `approved=${summary.approved} needs-changes=${summary.needsChanges} failed=${summary.failed}\n`);
            return;
        }
        case "qa":
            await qa();
            return;
        case "status": {
            const { runStatus } = await import("./status.js");
            await runStatus();
            return;
        }
        case "brief": {
            const arg = rest[0];
            if (!arg)
                await briefAllAwaitingQa();
            else {
                const n = Number(arg.replace(/^[#a-zA-Z-]*/, ""));
                if (Number.isNaN(n) || n <= 0) {
                    process.stderr.write(`usage: afk brief <issue-or-pr-number>\n`);
                    process.exit(2);
                }
                await brief(n);
            }
            return;
        }
        case "dashboard":
            process.exit(startDashboard());
        case "bootstrap":
            process.exit(bootstrap());
        case "telegram-test":
            process.exit(await telegramTest());
        case "reset": {
            const issueIdx = rest.indexOf("--issue");
            const arg = issueIdx >= 0 ? rest[issueIdx + 1] : undefined;
            if (!arg) {
                process.stderr.write(`usage: afk reset --issue <N>\n`);
                process.exit(2);
            }
            const { resetIssue } = await import("./reset.js");
            await resetIssue(Number(arg));
            return;
        }
        default:
            process.stderr.write(`unknown subcommand: ${subcommand}\n${HELP}`);
            process.exit(2);
    }
}
function printPlan(result, willDispatch) {
    const slotCapped = result.totalReady - result.ready.length;
    process.stdout.write(`ready=${result.totalReady} (dispatching ${result.ready.length} this round` +
        `${slotCapped > 0 ? `; ${slotCapped} slot-capped — next round` : ""}) ` +
        `blocked=${result.blocked.length} in-flight=${result.inFlight.length} ` +
        `prds-skipped=${result.skippedPrds.length} at-cap=${result.skippedAtCap.length} ` +
        `slots=${result.concurrencySlots}\n`);
    for (const i of result.ready)
        process.stdout.write(`  → #${i.number} ${i.title}\n`);
    for (const i of result.blocked)
        process.stdout.write(`  ⏸  #${i.number} ${i.title} (blocked-by)\n`);
    for (const i of result.inFlight)
        process.stdout.write(`  ▶  #${i.number} ${i.title}\n`);
    for (const i of result.skippedPrds)
        process.stdout.write(`  ⏭  #${i.number} ${i.title} (PRD — needs /to-issues)\n`);
    for (const i of result.skippedAtCap)
        process.stdout.write(`  ⛔ #${i.number} ${i.title} (attempt cap reached — needs human)\n`);
    if (!willDispatch && result.ready.length > 0) {
        process.stdout.write(`\n(dry-run — pass --dispatch to start ${result.ready.length} agent(s); or run \`afk loop\`)\n`);
    }
}
async function dispatchReady(ready) {
    process.stdout.write(`\n--- dispatching ${ready.length} agent(s) ---\n`);
    const settled = await Promise.allSettled(ready.map(dispatch));
    let approved = 0, needsChanges = 0, failed = 0;
    for (const s of settled) {
        if (s.status === "fulfilled") {
            switch (s.value.outcome.kind) {
                case "approved":
                    approved++;
                    break;
                case "needs-changes":
                    needsChanges++;
                    break;
                default: failed++;
            }
        }
        else
            failed++;
    }
    process.stdout.write(`\nDone. approved=${approved} needs-changes=${needsChanges} failed=${failed}\n`);
}
await main();
