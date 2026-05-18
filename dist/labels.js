// Label vocabulary driving the planner state machine.
//
//   ready-for-agent   → planner picks it up
//   afk-in-progress   → sandbox open, implementer running
//   afk-needs-review  → implementer done, awaiting reviewer
//   afk-needs-qa      → reviewer approved → PR open → awaiting day-shift QA
//   afk-needs-changes → reviewer or QA said no; user re-marks ready-for-agent to re-dispatch
//   blocked           → explicit user override; planner always skips
//
// The blocked-by: #N convention in issue bodies expresses dependencies that
// the planner enforces. It's the *only* way the planner learns about graph
// structure — no LLM in the planning step.
export const labels = {
    prdReady: "ready-for-agent",
    inProgress: "afk-in-progress",
    needsReview: "afk-needs-review",
    needsHumanQa: "afk-needs-qa",
    needsChanges: "afk-needs-changes",
    blocked: "blocked",
};
export const afkManagedLabels = [
    labels.inProgress,
    labels.needsReview,
    labels.needsHumanQa,
    labels.needsChanges,
];
// Labels the planner treats as "skip this issue, work is already in flight":
export const inFlightLabels = [
    labels.inProgress,
    labels.needsReview,
    labels.needsHumanQa,
    labels.blocked,
];
