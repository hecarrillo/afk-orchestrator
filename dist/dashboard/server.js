// `afk dashboard` — per-project ephemeral local web UI.
// Single-project, on-demand, dies on Ctrl-C.
//
// v0.1: STUB. The intended shape (per design grilling):
//   - Boot HTTP server on localhost:3737 (configurable via afk.config.json)
//   - Poll GitHub every ~30s for the configured repo's labels + bodies
//   - Poll local .afk-worktrees-* every ~5s for live commit count / dirty file delta
//   - Parse issues: "## Parent" body section → slice; "PRD:" title prefix or
//     "## Problem Statement" body → PRD; otherwise → loose issue
//   - Render a Mermaid DAG per PRD (color nodes by current label state)
//   - Click a node → side panel with `afk brief` output for that issue
//   - Loose issues bucket visible by default
//
// Implementation lands in a follow-up issue. For now this prints a placeholder
// so the CLI surface is complete.
import { config } from "../config.js";
export function startDashboard() {
    const port = config.dashboard?.port ?? 3737;
    const host = config.dashboard?.host ?? "127.0.0.1";
    process.stdout.write(`[dashboard] not yet implemented (v0.1 stub)\n` +
        `  would bind to http://${host}:${port}\n` +
        `  would poll ${config.repo} for label state + body parsing\n` +
        `  would render a Mermaid DAG per PRD, grouped slices, loose-issues bucket\n` +
        `  would tail .afk-worktrees-* for live commit counts\n` +
        `Track implementation in: https://github.com/hecarrillo/afk-orchestrator/issues\n`);
    return 0;
}
