// Bounded loop driver. Three stop conditions, whichever fires first:
//   (a) queue is empty   — nothing left to dispatch
//   (b) max round count  — config.maxRounds (default 5)
//   (c) wall-clock cap   — config.maxWallClockMs (default 4 hours)
//
// Each round = one planner pass + parallel dispatch of the ready slice.
// We wait for that round to finish (all sandboxes resolved) before planning
// the next one. Simpler to reason about than continuous dispatch, and the
// concurrency cap is enforced naturally by the planner returning at most
// `concurrencySlots` items per round.
//
// At startup, the loop checks for `afk-in-progress` issues whose updatedAt
// is older than the dispatcher's maximum possible runtime — these are
// zombies from a prior process that was killed mid-dispatch (laptop slept,
// terminal closed, OS OOM, etc.). The label sticks forever and would block
// the queue every round. We demote them to `afk-needs-changes` so the next
// planner pass picks them up as rework against their existing remote branch.
import { plan } from "./planner.js";
import { dispatch } from "./dispatcher.js";
import { config } from "./config.js";
import { send as notify } from "./subscribers/telegram.js";
import { listOpenIssuesByLabel, addLabels, removeLabels, commentOnIssue } from "./gh.js";
import { labels } from "./labels.js";
const ZOMBIE_BUFFER_MS = 5 * 60 * 1000; // grace period beyond the worst-case dispatch runtime
export async function loop() {
    const start = Date.now();
    const results = [];
    let approved = 0, needsChanges = 0, failed = 0;
    let reason = "empty-queue";
    let round = 0;
    await recoverZombies();
    for (round = 1; round <= config.maxRounds; round++) {
        if (Date.now() - start > config.maxWallClockMs) {
            reason = "wall-clock";
            break;
        }
        process.stdout.write(`\n=== AFK round ${round}/${config.maxRounds} ===\n`);
        const p = await plan();
        logPlan(p, round);
        if (p.ready.length === 0) {
            if (p.inFlight.length > 0) {
                process.stdout.write(`No new dispatches: ${p.inFlight.length} in-flight from a previous run; rerun once they finish.\n`);
                reason = "empty-queue";
                break;
            }
            process.stdout.write("Queue empty. Done.\n");
            reason = "empty-queue";
            break;
        }
        // Fan out the ready slice in parallel; wait for all to settle.
        const settled = await Promise.allSettled(p.ready.map(dispatch));
        let roundApproved = 0, roundNeedsChanges = 0, roundFailed = 0;
        for (const s of settled) {
            if (s.status === "fulfilled") {
                results.push(s.value);
                switch (s.value.outcome.kind) {
                    case "approved":
                        approved++;
                        roundApproved++;
                        break;
                    case "needs-changes":
                        needsChanges++;
                        roundNeedsChanges++;
                        break;
                    default:
                        failed++;
                        roundFailed++;
                }
            }
            else {
                failed++;
                roundFailed++;
                process.stderr.write(`Dispatch error: ${s.reason}\n`);
            }
        }
        void notify({ kind: "round.complete", round, approved: roundApproved, needsChanges: roundNeedsChanges, failed: roundFailed });
    }
    if (round > config.maxRounds)
        reason = "max-rounds";
    return {
        rounds: round - 1,
        totalDispatched: results.length,
        approved, needsChanges, failed,
        reason,
        results,
    };
}
/**
 * The maximum wall-clock time a healthy dispatch can occupy — implementer +
 * reviewer plus a small buffer. Anything older than this in `afk-in-progress`
 * is by definition a zombie.
 */
export function zombieThresholdMs() {
    return config.implementerTimeoutMs + config.reviewerTimeoutMs + ZOMBIE_BUFFER_MS;
}
/**
 * Pure predicate so callers can unit-test the policy without touching gh.
 * Returns true when `updatedAt` is older than `thresholdMs` relative to `now`.
 */
export function isZombie(updatedAt, now, thresholdMs) {
    const ts = Date.parse(updatedAt);
    if (Number.isNaN(ts))
        return false; // unparseable timestamp — don't auto-touch
    return now - ts > thresholdMs;
}
async function recoverZombies() {
    let inProgress;
    try {
        inProgress = await listOpenIssuesByLabel(labels.inProgress);
    }
    catch (err) {
        process.stderr.write(`[loop] zombie check skipped — couldn't list in-progress issues: ${err instanceof Error ? err.message : String(err)}\n`);
        return;
    }
    if (inProgress.length === 0)
        return;
    const now = Date.now();
    const threshold = zombieThresholdMs();
    const zombies = inProgress.filter(i => isZombie(i.updatedAt, now, threshold));
    if (zombies.length === 0)
        return;
    const ageMin = (i) => Math.round((now - Date.parse(i.updatedAt)) / 60000);
    process.stdout.write(`\n⚠️  recovering ${zombies.length} zombie in-flight issue(s) (in-progress > ${Math.round(threshold / 60000)}m):\n`);
    for (const z of zombies) {
        process.stdout.write(`  ${z.number} — last updated ${ageMin(z)}m ago: ${z.title}\n`);
        await removeLabels(z.number, [labels.inProgress, labels.needsReview]).catch(() => { });
        await addLabels(z.number, [labels.needsChanges]).catch(() => { });
        await commentOnIssue(z.number, `🧟 Zombie recovery: this issue was stuck in \`afk-in-progress\` for ${ageMin(z)} minutes — past the dispatcher's worst-case runtime, so the prior orchestrator was killed mid-dispatch. Resetting to \`afk-needs-changes\` so the next planner round picks it up as rework against the existing remote branch.`).catch(() => { });
    }
}
function logPlan(p, round) {
    const slotCapped = p.totalReady - p.ready.length;
    process.stdout.write(`round ${round}: ready=${p.totalReady} (dispatching ${p.ready.length}${slotCapped > 0 ? `; ${slotCapped} slot-capped` : ""}) blocked=${p.blocked.length} in-flight=${p.inFlight.length} at-cap=${p.skippedAtCap.length}\n`);
    for (const i of p.ready)
        process.stdout.write(`  → dispatching #${i.number} ${i.title}\n`);
    for (const i of p.blocked)
        process.stdout.write(`  ⏸  blocked #${i.number} ${i.title}\n`);
    for (const i of p.skippedPrds)
        process.stdout.write(`  ⏭  PRD: #${i.number} ${i.title}\n`);
    for (const i of p.skippedAtCap)
        process.stdout.write(`  ⛔ at-cap #${i.number} ${i.title} (needs human)\n`);
}
