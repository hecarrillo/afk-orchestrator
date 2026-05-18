// Rule-based planner. No LLM. Deterministic.
//
// One pass:
//   1. Fetch open issues with label `ready-for-agent` OR `afk-needs-changes`
//      (the latter is the auto-rework path: the planner picks up rejected
//      issues so the loop heals itself without manual re-labelling).
//   2. Skip any issue whose body references a blocked-by: #N where #N is
//      still open or in-flight.
//   3. Skip PRDs (title starts with "PRD:") — they need /to-issues splitting.
//   4. Skip anything already in an in-flight afk-* label.
//   5. Skip anything that has hit the attempt cap (afk-attempts-N label).
//   6. Return the unblocked queue, capped at concurrency - currentlyRunning.

import { listOpenIssuesByLabel, parseBlockedBy, getAttemptCount, type Issue } from "./gh.ts";
import { labels, inFlightLabels } from "./labels.ts";
import { config } from "./config.ts";

export interface PlannerResult {
  ready: Issue[];            // unblocked, ready to dispatch this round
  blocked: Issue[];          // referenced an open blocker
  inFlight: Issue[];         // already being worked on (counts against concurrency)
  skippedPrds: Issue[];      // PRD-shaped, need /to-issues
  skippedAtCap: Issue[];     // exceeded attempt cap; needs human intervention
  totalReady: number;        // ready before slot-cap (for accurate "ready=N" reporting)
  concurrencySlots: number;
}

export async function plan(): Promise<PlannerResult> {
  // Pull everything with any label we care about so we have a complete view.
  const queries = [labels.prdReady, labels.inProgress, labels.needsReview, labels.needsChanges];
  const fetched: Issue[] = [];
  const seen = new Set<number>();
  for (const lbl of queries) {
    for (const issue of await listOpenIssuesByLabel(lbl)) {
      if (!seen.has(issue.number)) {
        seen.add(issue.number);
        fetched.push(issue);
      }
    }
  }

  const inFlight = fetched.filter(i =>
    i.labels.some(l => inFlightLabels.includes(l.name)),
  );

  // Candidates: have either ready-for-agent OR afk-needs-changes, AND not in-flight.
  const candidates = fetched.filter(i => {
    const isReady = i.labels.some(l => l.name === labels.prdReady);
    const isRework = i.labels.some(l => l.name === labels.needsChanges);
    if (!isReady && !isRework) return false;
    if (i.labels.some(l => inFlightLabels.includes(l.name))) return false;
    return true;
  });

  const skippedPrds = candidates.filter(i => i.title.startsWith("PRD:"));
  const skippedAtCap = candidates.filter(i => getAttemptCount(i) >= config.maxAttempts);
  const implementable = candidates.filter(i =>
    !i.title.startsWith("PRD:") &&
    getAttemptCount(i) < config.maxAttempts,
  );

  // For each implementable, parse blocked-by refs.
  const openOrInflight = new Set<number>(fetched.map(i => i.number));
  const blocked: Issue[] = [];
  const ready: Issue[] = [];
  for (const issue of implementable) {
    const blockers = parseBlockedBy(issue.body);
    const stillOpen = blockers.filter(n => openOrInflight.has(n));
    if (stillOpen.length > 0) {
      blocked.push(issue);
    } else {
      ready.push(issue);
    }
  }

  const concurrencySlots = Math.max(0, config.concurrency - inFlight.length);
  return {
    ready: ready.slice(0, concurrencySlots),
    blocked,
    inFlight,
    skippedPrds,
    skippedAtCap,
    totalReady: ready.length,
    concurrencySlots,
  };
}
