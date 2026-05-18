// Spawn a one-shot claude CLI subprocess in a given working directory with
// --dangerously-skip-permissions. The agent reads the prompt, does the work,
// commits along the way, and exits. Long-running interactive sessions are NOT
// used — the orchestrator's whole shape depends on agents being a single
// async function that resolves when they're done.
import { execa } from "execa";
import { config } from "./config.js";
export async function runClaude(opts) {
    const start = Date.now();
    const args = [
        "--dangerously-skip-permissions",
        "--print", // non-interactive: emit final assistant reply and exit
        opts.prompt,
    ];
    const child = execa(config.claudeBin, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        reject: false,
        // Inherit a clean PATH; the agent should find swift, xcodebuild, etc.
        env: { ...process.env, CI: "1" },
    });
    if (opts.stream !== false && opts.label && child.stdout && child.stderr) {
        pipeWithPrefix(child.stdout, opts.label, process.stdout);
        pipeWithPrefix(child.stderr, opts.label, process.stderr);
    }
    const result = await child;
    const elapsedMs = Date.now() - start;
    // execa v9 doesn't expose result.timedOut directly; we infer from the
    // elapsed time hitting the budget AND a non-zero exit. False positives
    // are harmless — the dispatcher treats both as failure either way.
    const timedOut = elapsedMs >= opts.timeoutMs - 1000 && result.exitCode !== 0;
    return {
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout?.toString() ?? "",
        stderr: result.stderr?.toString() ?? "",
        timedOut,
        elapsedMs,
    };
}
function pipeWithPrefix(src, prefix, dest) {
    let buf = "";
    src.on("data", (chunk) => {
        buf += typeof chunk === "string" ? chunk : chunk.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            dest.write(`[${prefix}] ${line}\n`);
        }
    });
    src.on("end", () => {
        if (buf.length > 0)
            dest.write(`[${prefix}] ${buf}\n`);
    });
}
