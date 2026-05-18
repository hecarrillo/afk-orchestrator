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

import { plan } from "./planner.ts";
import { dispatch, type DispatchResult } from "./dispatcher.ts";
import { config } from "./config.ts";
import { send as notify } from "./subscribers/telegram.ts";

export interface LoopSummary {
  rounds: number;
  totalDispatched: number;
  approved: number;
  needsChanges: number;
  failed: number;
  reason: "empty-queue" | "max-rounds" | "wall-clock";
  results: DispatchResult[];
}

export async function loop(): Promise<LoopSummary> {
  const start = Date.now();
  const results: DispatchResult[] = [];
  let approved = 0, needsChanges = 0, failed = 0;
  let reason: LoopSummary["reason"] = "empty-queue";
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
    let roundApproved = 0, roundNeedsChanges = 0, roundFailed = 0;
    for (const s of settled) {
      if (s.status === "fulfilled") {
        results.push(s.value);
        switch (s.value.outcome.kind) {
          case "approved":       approved++; roundApproved++; break;
          case "needs-changes":  needsChanges++; roundNeedsChanges++; break;
          default:               failed++; roundFailed++;
        }
      } else {
        failed++;
        roundFailed++;
        process.stderr.write(`Dispatch error: ${s.reason}\n`);
      }
    }
    void notify({ kind: "round.complete", round, approved: roundApproved, needsChanges: roundNeedsChanges, failed: roundFailed });
  }

  if (round > config.maxRounds) reason = "max-rounds";
  return {
    rounds: round - 1,
    totalDispatched: results.length,
    approved, needsChanges, failed,
    reason,
    results,
  };
}

function logPlan(p: Awaited<ReturnType<typeof plan>>, round: number): void {
  const slotCapped = p.totalReady - p.ready.length;
  process.stdout.write(`round ${round}: ready=${p.totalReady} (dispatching ${p.ready.length}${slotCapped > 0 ? `; ${slotCapped} slot-capped` : ""}) blocked=${p.blocked.length} in-flight=${p.inFlight.length} at-cap=${p.skippedAtCap.length}\n`);
  for (const i of p.ready) process.stdout.write(`  → dispatching #${i.number} ${i.title}\n`);
  for (const i of p.blocked) process.stdout.write(`  ⏸  blocked #${i.number} ${i.title}\n`);
  for (const i of p.skippedPrds) process.stdout.write(`  ⏭  PRD: #${i.number} ${i.title}\n`);
  for (const i of p.skippedAtCap) process.stdout.write(`  ⛔ at-cap #${i.number} ${i.title} (needs human)\n`);
}
