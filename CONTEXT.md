# AFK orchestrator

A local agent orchestrator that runs Claude Code AFK against GitHub issues, with mandatory automated review and a per-project ephemeral dashboard. Designed for Next.js and Swift projects, used by one person and shared with one company.

## Language

**Project**:
A consumer repository the orchestrator runs against. Each project has its own `afk.config.json` and its own issue tracker on GitHub.
_Avoid_: workspace, codebase

**PRD**:
A parent issue describing a feature spec, produced by `/to-prd`. Identified by a `PRD:` title prefix (mandatory) or a `## Problem Statement` body section. A PRD is **never dispatched directly** — the planner skips it and waits for `/to-issues` to split it into slices.
_Avoid_: spec, ticket, feature request

**Slice**:
An implementation issue derived from a PRD via `/to-issues`. Identified by a `## Parent` body section pointing at the parent PRD with `#N`. Each slice has acceptance criteria and may have `blocked-by: #M` lines that form the DAG.
_Avoid_: child issue, sub-task

**Loose issue**:
An open issue that is neither a PRD nor a slice — i.e., a bug fix or chore that wasn't produced by `/to-prd` + `/to-issues`. Visible on the dashboard in its own bucket.
_Avoid_: orphan

**Worktree**:
An isolated git workspace where an implementer agent does its work, created by `git worktree add` from origin's base branch (fresh attempt) or from the existing remote branch (rework). Located at a sibling-of-repo path like `../.afk-worktrees-<repo>/issue-N/`.

**Implementer**:
The agent role that takes an issue body + (on rework) prior PR feedback and writes commits. Runs as `claude --dangerously-skip-permissions --print` in a worktree.

**Reviewer**:
The agent role that runs after the implementer, judges the diff against the issue + ADRs + CONTEXT.md, and writes a verdict file `AFK_REVIEW.md`. Read-only by contract — it cannot edit source.

**Verdict**:
The reviewer's decision, written to `AFK_REVIEW.md` as the first line: `verdict: approve` or `verdict: request-changes`. Always posted to the PR as a `--comment` review (never `--approve`, to avoid GitHub's same-author block).

**Dispatch**:
One issue end-to-end: worktree → implementer → reviewer → PR open or update → label transition. Returns an outcome (approved / needs-changes / failed).

**Round**:
A single planner pass + parallel dispatch of the ready slice (up to `concurrency`). The `loop` subcommand runs many rounds until empty queue, round cap, or wall-clock cap.

**Rework**:
A second-or-later dispatch of the same issue, triggered automatically by the planner when the issue carries `afk-needs-changes`. The implementer adopts the existing branch and sees all prior PR comments inlined as "Prior feedback to address" in its prompt.

**Hook**:
A consumer-provided shell command run at a specific lifecycle point. v1 has one: `postCreateWorktree`, executed after the worktree is created. Receives `AFK_WORKTREE_PATH`, `AFK_ISSUE_NUMBER`, `AFK_BRANCH`, `AFK_IS_REWORK` as env vars.

**Bootstrap**:
The Next.js-flavoured `postCreateWorktree` implementation shipped as `afk bootstrap`. Symlinks `node_modules`, `.env`, and other configured paths from a base repo into the fresh worktree instead of duplicating gigabytes per workspace. Idempotent and safe against clobbering real installs.

**Subscriber**:
An event consumer that receives milestone events from the orchestrator. v1 ships one: the Telegram subscriber. Outbound only — no inbound bot, no daemon.

**Dashboard**:
The per-project ephemeral local web UI (`afk dashboard`). Renders a Mermaid DAG of every PRD's slices, polls GitHub every ~30s for label state, polls local worktrees every ~5s for live commit deltas. Dies on Ctrl-C.

## Relationships

- A **PRD** has zero or more child **Slices**
- A **Slice** belongs to exactly one **PRD** (via `## Parent`)
- A **Slice** has zero or more **blocked-by** edges to other Slices within the same PRD
- A **Dispatch** acts on one Slice (PRDs are never dispatched)
- A **Round** produces zero or more concurrent **Dispatches** (capped by `concurrency`)
- A **Rework** is a Dispatch whose worktree adopts an existing remote branch
- The **Dashboard** shows one **Project**'s PRDs, Slices, and Loose issues

## Example dialogue

> **User:** I just ran `/to-prd` and got a new PRD on the tracker. Now what?
>
> **Engineer:** Run `/to-issues` next — that turns the PRD into Slices with `## Parent` references and `blocked-by` edges between them. The Planner ignores the PRD itself (it skips anything with the `PRD:` title prefix) but will pick up the Slices as soon as they're ready and any blockers are resolved.
>
> **User:** And if a Slice's review fails?
>
> **Engineer:** It transitions to `afk-needs-changes`. The Planner auto-picks it up next round as a Rework — the Implementer sees every prior PR comment inlined.

## Flagged ambiguities

- "Issue" used to mean both **PRD** and **Slice**. Resolved: they're distinct kinds detected by body-section parsing. "Issue" in code stays as the broad GitHub type; "PRD" and "Slice" are domain types.
- "Workspace" used to mean both **Project** and **Worktree**. Resolved: Project is the consumer repo, Worktree is one isolated checkout per dispatched Slice.
