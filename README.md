# `@hecarrillo/afk` — local agent orchestrator

Run Claude Code AFK against GitHub issues, with mandatory automated review and a per-project ephemeral dashboard. Local, no cloud, no Docker. Targets Next.js and Swift projects.

This is a personal/company tool — not production-positioned, not OSS-positioned, no semver. Pin consumers to commit SHAs.

## The shape

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ planner  │──▶│ implement │──▶│ reviewer │──▶│   PR +    │
│  (rules) │    │  (claude) │    │ (claude) │    │ human QA  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     ▲                                                │
     └────────────────────────────────────────────────┘
                     loop until done
```

- **Planner** — rule-based, no LLM. Reads issues by label, parses `blocked-by: #N` body lines, dispatches the unblocked ones.
- **Implementer** — `claude --dangerously-skip-permissions -p "..."` in a fresh worktree on `afk/issue-N`. Reads `CONTEXT.md` + ADRs + the issue body. On a rework, the prompt is augmented with every prior PR comment / review.
- **Reviewer** — same model in the same worktree, read-only by contract. Writes a verdict to `AFK_REVIEW.md`. Orchestrator parses it, posts the report as a PR review-comment.
- **Dashboard** — per-project, ephemeral, on-demand. Mermaid DAG of every PRD's slices. Polls GitHub + local worktrees. Dies on Ctrl-C.

Full domain model: [`CONTEXT.md`](./CONTEXT.md). Architectural decisions: [`docs/adr/`](./docs/adr/).

## Install

### Next.js project (per-project)

```sh
cd ~/code/my-nextjs-app
npm install --save-dev github:hecarrillo/afk-orchestrator
```

Add to `package.json` scripts if you want shortcuts:
```json
{
  "scripts": {
    "afk": "afk"
  }
}
```

Invoke with `npx afk plan` (or `npm run afk plan`).

### Swift project (global)

Swift repos shouldn't drag npm into their root. Install once globally:

```sh
npm install -g github:hecarrillo/afk-orchestrator
```

Invoke `afk plan` from any project directory.

## Configure

Each project gets an `afk.config.json` at its root. Minimal:

```json
{
  "repo": "hecarrillo/my-nextjs-app",
  "baseBranch": "main"
}
```

Full schema (all fields optional except `repo`):

```json
{
  "repo": "hecarrillo/my-nextjs-app",
  "baseBranch": "main",
  "concurrency": 3,
  "maxRounds": 5,
  "maxAttempts": 3,
  "implementerTimeoutMs": 1800000,
  "reviewerTimeoutMs": 600000,

  "postCreateWorktree": "afk bootstrap",
  "bootstrap": {
    "base": "$HOME/code/my-nextjs-app",
    "linkPaths": ["node_modules", ".env", ".env.local"]
  },

  "notifications": {
    "telegram": { "chatId": "123456789" }
  },

  "dashboard": {
    "port": 3737,
    "host": "127.0.0.1"
  }
}
```

Secrets stay in env vars:
- `AFK_TELEGRAM_BOT_TOKEN` — required to enable Telegram notifications
- `AFK_REPO` — overrides `repo` (useful for one-off runs against a different repo)
- All other env overrides documented in [`src/config.ts`](./src/config.ts)

## Commands

```sh
afk plan                       # DRY RUN: prints what would dispatch
afk plan --dispatch            # plan + dispatch one round
afk loop                       # bounded multi-round driver (night-shift mode)
afk qa                         # day-shift: walks PRs awaiting human QA
afk status                     # snapshot: in-progress / awaiting-review / awaiting-QA
afk brief [N]                  # full context for issue/PR N (or all awaiting QA)
afk dashboard                  # per-project live UI (Mermaid DAG, polls GitHub + worktrees)
afk bootstrap                  # wire fresh worktree to a base repo via symlinks
afk telegram-test              # send a test Telegram message
afk reset --issue N            # emergency: clean up worktree + reset labels for #N
afk --help
```

## Label vocabulary

The orchestrator owns these labels on each consumer repo. First run will create them on demand.

| Label | Meaning |
|---|---|
| `ready-for-agent` | Planner picks up. User sets this on a Slice when it's ready. |
| `afk-in-progress` | Sandbox is open; implementer running. |
| `afk-needs-review` | Implementer done; reviewer running. |
| `afk-needs-qa` | Reviewer approved → PR open → awaiting human QA. |
| `afk-needs-changes` | Reviewer or QA said no. **Auto-picked up next planner round.** |
| `afk-attempts-N` | Per-issue counter. Resets on merge. After `maxAttempts` (default 3), planner skips. |
| `blocked` | Explicit user override. Planner always skips. |
| `hitl` | Optional informational tag — HITL slices get extra-careful human QA. |

Dependency edges between slices are expressed in the slice body, one per line:

```markdown
blocked-by: #14
blocked-by: #17
```

If any referenced issue is still open or in-flight, the planner skips the dependent.

## PRD/Slice detection

The dashboard groups issues by their parent PRD. Detection rules, parsed from each open issue:

1. Body contains `## Parent` with `#N` → it's a **slice** of PRD `#N`.
2. Title starts with `PRD: ` OR body contains `## Problem Statement` → it's a **PRD**.
3. Neither → **loose issue** (visible in its own bucket).

`/to-prd` and `/to-issues` already write the body sections this depends on — no skill changes needed.

## Status

v0.1 — initial port from r2m's in-tree `tools/afk/`. Following pieces are stubs and will land in follow-up issues:

- [ ] `afk dashboard` — Mermaid DAG + polling server (stubbed)
- [ ] Telegram subscriber implementation (stubbed; `afk telegram-test` confirms config)
- [ ] Event bus + structured logging
- [ ] `npm install` `prepare` step build verification on consumer install

Working today:
- [x] Planner with rule-based dispatch, `blocked-by` parsing, attempt cap
- [x] Dispatcher with PR-aware auto-rework
- [x] Implementer + reviewer prompts with prior-feedback inlining
- [x] `afk qa` walks PRs with auto-rendered brief
- [x] `afk status` snapshot
- [x] `afk brief` issue + PR + reviewer context
- [x] `afk bootstrap` for Next.js worktree setup (port of `conductor-bootstrap`)
- [x] `afk reset` emergency cleanup
