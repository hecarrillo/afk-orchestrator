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

> **Note:** Both install commands below require `--install-links` on npm 11+. Without it, the install leaves a dangling symlink instead of a real directory (the package contents end up cleaned up post-install).

### Next.js project (per-project)

```sh
cd ~/code/my-nextjs-app
npm install --save-dev --install-links github:hecarrillo/afk-orchestrator
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
npm install -g --install-links github:hecarrillo/afk-orchestrator
```

Invoke `afk plan` from any project directory.

## Configure

AFK splits configuration into two layers so a team can commit one `afk.config.json` and have every developer pick it up cleanly:

- **`afk.config.json`** (committed) — repo, branch, concurrency, link paths, dashboard. Same for everyone.
- **Per-developer env vars** (shell rc) — bot tokens, chat IDs, machine-specific overrides. Different per machine.

### Committed `afk.config.json`

Each project gets one `afk.config.json` at its root and commits it. Minimal:

```json
{
  "repo": "YOUR-ORG/YOUR-REPO",
  "baseBranch": "main"
}
```

Team-shareable Next.js shape (matches `examples/afk.config.nextjs.json`):

```json
{
  "repo": "YOUR-ORG/YOUR-REPO",
  "baseBranch": "main",
  "concurrency": 3,
  "postCreateWorktree": "afk bootstrap",
  "bootstrap": {
    "linkPaths": ["node_modules", ".env", ".env.local"]
  },
  "notifications": {
    "telegram": {}
  }
}
```

Notes:
- `bootstrap.base` is **optional**. When omitted, `afk bootstrap` auto-detects the base repo from the current worktree's git metadata (`git rev-parse --git-common-dir`'s parent). Set `base` explicitly only if you keep your canonical checkout at a path no `git worktree` walk would find.
- `notifications.telegram: {}` marks Telegram as opt-in: notifications fire iff each developer has both `AFK_TELEGRAM_BOT_TOKEN` and `AFK_TELEGRAM_CHAT_ID` set. No chat ID belongs in the committed file.

Full schema with explicit defaults:

```json
{
  "repo": "YOUR-ORG/YOUR-REPO",
  "baseBranch": "main",
  "concurrency": 3,
  "maxRounds": 5,
  "maxAttempts": 3,
  "implementerTimeoutMs": 1800000,
  "reviewerTimeoutMs": 600000,

  "postCreateWorktree": "afk bootstrap",
  "bootstrap": {
    "base": "$HOME/code/your-repo",
    "linkPaths": ["node_modules", ".env", ".env.local"]
  },

  "notifications": {
    "telegram": { "chatId": "987654321" }
  },

  "dashboard": {
    "port": 3737,
    "host": "127.0.0.1"
  }
}
```

> **Note:** The full schema above shows `notifications.telegram.chatId` as an example, but committing a real chat ID is discouraged for shared repos (one teammate ends up receiving everyone's pings). Use the empty `"telegram": {}` marker shape from the team-shareable example above and let each developer set `AFK_TELEGRAM_CHAT_ID` in their shell rc.

### Per-developer setup (env vars)

Each developer sets these once per machine, typically in `~/.zshrc` or `~/.bashrc`:

```sh
export AFK_TELEGRAM_BOT_TOKEN="123456789:ABC-def-GHI..."   # bot token from @BotFather
export AFK_TELEGRAM_CHAT_ID="987654321"                    # YOUR chat ID, not a teammate's
```

Other env vars that override committed config (documented in [`src/config.ts`](./src/config.ts)):
- `AFK_REPO` — overrides `repo` (useful for one-off runs)
- `AFK_BASE_BRANCH`, `AFK_CONCURRENCY`, `AFK_MAX_ROUNDS`, `AFK_MAX_ATTEMPTS`
- `AFK_IMPL_TIMEOUT_MS`, `AFK_REVIEW_TIMEOUT_MS`, `AFK_MAX_WALLCLOCK_MS`
- `AFK_CLAUDE_BIN`, `AFK_GH_BIN`

If both env var and committed config provide a value, env var wins.

## Telegram setup

Outbound milestone notifications (dispatch start, implementer done, reviewer verdict, PR opened/updated, round complete, failures, cap-hits). All sends are silent no-ops when either env var is missing — the orchestrator stays usable without Telegram.

**1. Create the bot.** In Telegram, message `@BotFather`:

```
/newbot
<a name, e.g. "Hector AFK">
<a username ending in "bot", e.g. "hector_afk_bot">
```

BotFather replies with a token like `123456789:ABC-def-GHI...`. Keep it private.

**2. Get your chat ID.** Send any message to your new bot, then:

```sh
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[0].message.chat.id'
```

Returns a number like `987654321`.

**3. Wire it up — per developer, in `~/.zshrc`:**

```sh
export AFK_TELEGRAM_BOT_TOKEN="123456789:ABC-def-GHI..."
export AFK_TELEGRAM_CHAT_ID="987654321"
```

**4. Enable in the committed `afk.config.json`** by adding the marker:

```json
{
  "notifications": {
    "telegram": {}
  }
}
```

This empty block tells the orchestrator "Telegram is opt-in here — send if the env vars are set, otherwise no-op". A `chatId` field in the committed config is supported as a fallback but discouraged for shared repos (one teammate ends up receiving everyone's pings).

**5. Verify:**

```sh
afk telegram-test
```

Errors talking to Telegram print to stderr but never fail a dispatch.

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
- [ ] Event bus + structured logging
- [ ] `npm install` `prepare` step build verification on consumer install

Working today:
- [x] Planner with rule-based dispatch, `blocked-by` parsing, attempt cap
- [x] Dispatcher with PR-aware auto-rework
- [x] Implementer + reviewer prompts with prior-feedback inlining
- [x] `afk qa` walks PRs with auto-rendered brief
- [x] `afk status` snapshot
- [x] `afk brief` issue + PR + reviewer context
- [x] `afk bootstrap` for Next.js worktree setup, with auto-detection of the base repo from worktree git metadata
- [x] Telegram milestone subscriber with `AFK_TELEGRAM_CHAT_ID` env-var fallback
- [x] `afk reset` emergency cleanup

## Smoke-testing from a fresh machine

To verify a fresh developer can install and use AFK without editing any committed file:

```sh
# 1. Install globally from the public GitHub repo (no clone needed).
#    --install-links is required on npm 11+; see the Install section above.
npm install -g --install-links github:hecarrillo/afk-orchestrator
afk --help

# 2. In your target project, commit `afk.config.json` with the team-shareable
#    shape from examples/afk.config.nextjs.json. Do NOT include
#    `bootstrap.base` or `notifications.telegram.chatId`.

# 3. In your shell rc, set your own Telegram credentials (optional):
export AFK_TELEGRAM_BOT_TOKEN="<your bot token>"
export AFK_TELEGRAM_CHAT_ID="<your chat id>"

# 4. Verify each piece:
cd ~/path/to/project
afk plan                # dry-run; should print a planning summary
afk telegram-test       # arrives in YOUR chat (or no-op without env vars)
git worktree add ../tmp-wt && cd ../tmp-wt
afk bootstrap           # auto-detects base; reports `base: <path> (auto-detected)`
```

If `afk bootstrap` reports `base: <path> (auto-detected)`, the per-developer install is wired up correctly. Clean up the test worktree with `cd .. && git worktree remove ../tmp-wt` when finished.
