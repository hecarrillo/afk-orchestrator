# 0001 — Visibility lives on GitHub plus an ephemeral local dashboard, not a daemon

Date: 2026-05-18
Status: Accepted

## Context

The orchestrator needs to surface "what's happening right now" to the operator:
- Cross-project ("what's the state of every agent across every project I run AFK against?")
- Per-project ("what's the dependency graph of this PRD and where is each slice?")
- Notifications ("ping me when shit gets done so I can QA from my phone")

Two natural architectures were considered, and we explicitly chose against the more involved one.

## Decision

- **Cross-project visibility lives on GitHub.** A saved GitHub Project view filters by the AFK label vocabulary (`afk-in-progress`, `afk-needs-qa`, etc.) across all AFK-enabled repos. Phone access via the GitHub mobile app. Zero infrastructure on our side.
- **Per-project visibility lives in `afk dashboard`** — a local, ephemeral, single-project web UI. Started on demand from the project root, dies on Ctrl-C. Renders a Mermaid DAG per PRD, polls GitHub every ~30s for label state, polls local worktrees every ~5s for live commit counts.
- **Notifications are outbound only** — a Telegram subscriber that fires on milestone events. No inbound bot, no `/status` command, no listener.
- **No always-on daemon.** The orchestrator is invoked when work needs to happen (`afk loop`) or visibility is wanted (`afk dashboard`), and exits when done.

## Alternatives considered

- **Always-on `afk daemon` with a long-poll Telegram listener** so `/status` from a phone responds even when no orchestrator is active. Rejected because (a) the GitHub mobile app already provides exactly that experience for label state, and (b) maintaining a daemon means launchd plists, restart logic, error recovery, and a process the user has to remember is running.
- **Hosted dashboard / webhook server.** Required a public URL, auth surface, and operational story. Massive overkill for a personal/company tool.
- **Migrating to OpenAI's Symphony.** Symphony is Linear + Codex + Elixir; we are GitHub + Claude + Node. The pattern is the same shape but the constraints don't match — borrowed the "platform-as-dashboard" idea, not the code.

## Consequences

- **Phone-accessibility is GitHub's job.** When the operator wants visibility while away from their laptop, they open the GitHub mobile app to a saved Project filter. They do not ping a bot.
- **The dashboard is ephemeral and per-project.** No `~/.afk/projects.json` registry. To see two projects at once you open two terminals on two ports. Cross-project aggregation lives on GitHub.
- **The Telegram surface is small.** Outbound milestone pings only — ~20 lines, no dependencies, env-var-gated. Skippable for users who don't want notifications.
- **If GitHub goes down, we have no visibility.** Accepted — we have no visibility today either.
- **Migration to a more involved visibility model is not blocked.** The orchestrator already emits typed events; a future daemon or hosted dashboard would consume the same event stream without re-architecting the dispatcher.
