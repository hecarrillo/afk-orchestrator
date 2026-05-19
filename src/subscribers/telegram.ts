// Telegram milestone subscriber. Outbound only — no inbound bot, no daemon.
//
// Configured via env (AFK_TELEGRAM_BOT_TOKEN required) + chat ID from either
// AFK_TELEGRAM_CHAT_ID env var (preferred) or afk.config.json
// (notifications.telegram.chatId). If the token or chat ID is missing every
// call is a silent no-op so the orchestrator stays usable without
// notifications.
//
// Sends to https://api.telegram.org/bot<token>/sendMessage with Markdown
// formatting. Best-effort: if the send fails, we log to stderr and continue.

import { config } from "../config.ts";

const TOKEN_ENV = "AFK_TELEGRAM_BOT_TOKEN";
const CHAT_ID_ENV = "AFK_TELEGRAM_CHAT_ID";
const API_BASE = "https://api.telegram.org";

/**
 * Resolve the Telegram chat ID with the documented priority:
 * 1. `AFK_TELEGRAM_CHAT_ID` env var (per-developer, set in shell rc)
 * 2. `notifications.telegram.chatId` from afk.config.json (committed default)
 *
 * Empty env values are treated as unset so a developer can scrub
 * `AFK_TELEGRAM_CHAT_ID=` in CI without falling back to config.
 *
 * Exported for testability — production callers use the no-arg `chatId()`.
 */
export function resolveChatId(
  src: { envValue: string | undefined; configValue: string | undefined },
): string | undefined {
  if (src.envValue && src.envValue.length > 0) return src.envValue;
  return src.configValue;
}

function chatId(): string | undefined {
  return resolveChatId({
    envValue: process.env[CHAT_ID_ENV],
    configValue: config.notifications?.telegram?.chatId,
  });
}

export type MilestoneEvent =
  | { kind: "dispatch.started"; issueNumber: number; title: string; attempt: number; isRework: boolean }
  | { kind: "implementer.finished"; issueNumber: number; commits: number; elapsedMs: number }
  | { kind: "reviewer.verdict"; issueNumber: number; verdict: "approve" | "request-changes" }
  | { kind: "pr.opened"; issueNumber: number; prNumber: number; prUrl: string }
  | { kind: "pr.updated"; issueNumber: number; prNumber: number; prUrl: string; attempt: number }
  | { kind: "outcome"; issueNumber: number; outcomeKind: string; prUrl?: string }
  | { kind: "round.complete"; round: number; approved: number; needsChanges: number; failed: number }
  | { kind: "cap.hit"; issueNumber: number; attempts: number }
  | { kind: "failure"; issueNumber: number; reason: string };

function enabled(): boolean {
  return Boolean(process.env[TOKEN_ENV]) && Boolean(chatId());
}

function repoLabel(): string {
  // Just the "name" half of "owner/name" — enough to disambiguate when
  // pinged from multiple projects without taking up half the message.
  return config.repo.split("/").pop() ?? config.repo;
}

function format(event: MilestoneEvent): string {
  const r = repoLabel();
  switch (event.kind) {
    case "dispatch.started":
      return event.isRework
        ? `🔁 *${r}* — rework attempt ${event.attempt} on #${event.issueNumber}\n${event.title}`
        : `🚀 *${r}* — dispatching #${event.issueNumber} (attempt ${event.attempt})\n${event.title}`;
    case "implementer.finished": {
      const minutes = (event.elapsedMs / 60000).toFixed(1);
      return `✅ *${r}* — #${event.issueNumber} implementer done — ${event.commits} commit(s) in ${minutes}m`;
    }
    case "reviewer.verdict": {
      const emoji = event.verdict === "approve" ? "👁" : "↩️";
      const text = event.verdict === "approve" ? "APPROVE" : "REQUEST CHANGES";
      return `${emoji} *${r}* — #${event.issueNumber} reviewer: *${text}*`;
    }
    case "pr.opened":
      return `📬 *${r}* — PR [#${event.prNumber}](${event.prUrl}) opened for #${event.issueNumber} — awaiting human QA`;
    case "pr.updated":
      return `🔄 *${r}* — PR [#${event.prNumber}](${event.prUrl}) updated (attempt ${event.attempt})`;
    case "outcome": {
      if (event.outcomeKind === "approved" && event.prUrl)
        return `🟢 *${r}* — #${event.issueNumber} approved by auto-reviewer · ${event.prUrl}`;
      if (event.outcomeKind === "needs-changes")
        return `🟡 *${r}* — #${event.issueNumber} needs changes — auto-rework next round`;
      return `⚪️ *${r}* — #${event.issueNumber} outcome: ${event.outcomeKind}`;
    }
    case "round.complete":
      return `🏁 *${r}* — round ${event.round} complete · approved ${event.approved} · changes ${event.needsChanges} · failed ${event.failed}`;
    case "cap.hit":
      return `⛔ *${r}* — #${event.issueNumber} hit attempt cap (${event.attempts}) — needs human`;
    case "failure":
      return `❌ *${r}* — #${event.issueNumber} failed: ${event.reason}`;
  }
}

async function postMessage(text: string): Promise<void> {
  const token = process.env[TOKEN_ENV];
  const id = chatId();
  if (!token || !id) return;

  const url = `${API_BASE}/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: id,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      process.stderr.write(`[telegram] HTTP ${res.status}: ${body.slice(0, 200)}\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[telegram] send failed: ${msg}\n`);
  }
}

export async function send(event: MilestoneEvent): Promise<void> {
  if (!enabled()) return;
  await postMessage(format(event));
}

export async function test(): Promise<number> {
  if (!process.env[TOKEN_ENV]) {
    process.stderr.write(
      `missing ${TOKEN_ENV} env var.\n` +
      `Set it in your shell rc:\n` +
      `  export ${TOKEN_ENV}="<your_bot_token_from_BotFather>"\n`,
    );
    return 2;
  }
  const id = chatId();
  if (!id) {
    process.stderr.write(
      `no Telegram chat ID configured.\n` +
      `Set one of:\n` +
      `  export ${CHAT_ID_ENV}="<your_chat_id>"          # per-developer (recommended)\n` +
      `  OR add to ${config.configPath}:\n` +
      `  "notifications": { "telegram": { "chatId": "<your_chat_id>" } }\n`,
    );
    return 2;
  }

  const repoName = repoLabel();
  const text =
    `🔧 *${repoName}* — AFK orchestrator test\n` +
    `If you see this, your bot token and chat ID are wired up correctly.\n` +
    `_${new Date().toLocaleString()}_`;
  await postMessage(text);
  process.stdout.write(`sent test message to chat ${id}\n`);
  return 0;
}
