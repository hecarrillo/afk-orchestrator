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
import { plan } from "./planner.js";
import { dispatch } from "./dispatcher.js";
import { config } from "./config.js";
export async function loop() {
    const start = Date.now();
    const results = [];
    let approved = 0, needsChanges = 0, failed = 0;
    let reason = "empty-queue";
    let round = 0;
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
        for (const s of settled) {
            if (s.status === "fulfilled") {
                results.push(s.value);
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
            else {
                failed++;
                process.stderr.write(`Dispatch error: ${s.reason}\n`);
            }
        }
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
