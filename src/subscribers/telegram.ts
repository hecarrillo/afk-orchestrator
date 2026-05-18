// Telegram milestone subscriber. Outbound only — no inbound bot, no daemon.
// Configured via env (AFK_TELEGRAM_BOT_TOKEN) + afk.config.json (chatId).
// If either is missing, every send is a no-op so the orchestrator stays usable.
//
// v0.1: STUB. Implementation lands in a follow-up. Exposed via `afk telegram-test`
// so you can validate your bot setup without running a real dispatch.

import { config } from "../config.ts";

const TOKEN_ENV = "AFK_TELEGRAM_BOT_TOKEN";

export type MilestoneEvent =
  | { kind: "dispatch.started"; issueNumber: number; title: string; attempt: number }
  | { kind: "implementer.finished"; issueNumber: number; commits: number }
  | { kind: "reviewer.verdict"; issueNumber: number; verdict: "approve" | "request-changes" }
  | { kind: "pr.opened"; issueNumber: number; prUrl: string }
  | { kind: "pr.updated"; issueNumber: number; prUrl: string; attempt: number }
  | { kind: "outcome"; issueNumber: number; kind2: string; prUrl?: string }
  | { kind: "round.complete"; round: number; approved: number; needsChanges: number; failed: number }
  | { kind: "cap.hit"; issueNumber: number }
  | { kind: "failure"; issueNumber: number; reason: string };

function enabled(): boolean {
  return Boolean(process.env[TOKEN_ENV]) && Boolean(config.notifications?.telegram?.chatId);
}

export async function send(_event: MilestoneEvent): Promise<void> {
  if (!enabled()) return;
  // TODO: implement POST to https://api.telegram.org/bot<token>/sendMessage
  // with a Markdown-formatted body per `kind`.
  process.stderr.write(`[telegram] (stub) would send: ${_event.kind} #${"issueNumber" in _event ? _event.issueNumber : "n/a"}\n`);
}

export async function test(): Promise<number> {
  if (!process.env[TOKEN_ENV]) {
    process.stderr.write(`missing ${TOKEN_ENV} env var\n`);
    return 2;
  }
  if (!config.notifications?.telegram?.chatId) {
    process.stderr.write(`no notifications.telegram.chatId in ${config.configPath}\n`);
    return 2;
  }
  process.stdout.write(`(stub) would send a test message to chat ${config.notifications.telegram.chatId}\n`);
  return 0;
}
