// Telegram milestone subscriber. Outbound only — no inbound bot, no daemon.
// Configured via env (AFK_TELEGRAM_BOT_TOKEN) + afk.config.json (chatId).
// If either is missing, every send is a no-op so the orchestrator stays usable.
//
// v0.1: STUB. Implementation lands in a follow-up. Exposed via `afk telegram-test`
// so you can validate your bot setup without running a real dispatch.
import { config } from "../config.js";
const TOKEN_ENV = "AFK_TELEGRAM_BOT_TOKEN";
function enabled() {
    return Boolean(process.env[TOKEN_ENV]) && Boolean(config.notifications?.telegram?.chatId);
}
export async function send(_event) {
    if (!enabled())
        return;
    // TODO: implement POST to https://api.telegram.org/bot<token>/sendMessage
    // with a Markdown-formatted body per `kind`.
    process.stderr.write(`[telegram] (stub) would send: ${_event.kind} #${"issueNumber" in _event ? _event.issueNumber : "n/a"}\n`);
}
export async function test() {
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
