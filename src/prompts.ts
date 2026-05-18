// Prompt templates for the implementer and reviewer agents.
//
// Design notes:
// - Both agents are given strict scope. The implementer ONLY touches what the
//   issue describes; the reviewer ONLY judges, never mutates.
// - Reviewer writes its verdict to a file (AFK_REVIEW.md) in the worktree so
//   the orchestrator can parse it deterministically without depending on
//   claude's stdout format.
// - Neither agent opens PRs or pushes branches — the orchestrator does that.

import type { Issue, PrComment } from "./gh.ts";

export function implementerPrompt(issue: Issue, priorFeedback: PrComment[] = []): string {
  const isRework = priorFeedback.length > 0;
  const reworkBanner = isRework
    ? `

# IMPORTANT: This is a REWORK, not a first attempt.

A previous round of work on this issue produced commits on the branch \`afk/issue-${issue.number}\` that were rejected. Those commits are checked out for you — extend them, do NOT reset or rewrite history.

Read the **Prior feedback** section below first. Every concrete finding there must be either:
- **Addressed** with a code change in this round, OR
- **Pushed back on** with a brief comment in your commit message explaining why a finding is wrong or out of scope.

Do NOT silently ignore feedback. The reviewer will check.
`
    : "";

  return `You are an implementation agent working on a single GitHub issue inside an isolated git worktree.${reworkBanner}

# Your task

Implement the work described in the issue below. You are in ${isRework ? "a worktree with prior commits on" : "a fresh worktree on"} the branch \`afk/issue-${issue.number}\`. The branch is checked out for you — start from the current state of the working tree.

## Issue #${issue.number}: ${issue.title}

${issue.body}

# Rules

1. **Stay in scope.** Implement exactly what the issue describes. Do not refactor adjacent code, do not add features that "would be nice", do not add unrequested documentation.
2. **Read CONTEXT.md and any ADRs under docs/adr/ before writing code.** They contain locked design decisions that your work must respect.
3. **Make small, atomic commits with clear messages** as you go. The reviewer will look at each commit.
4. **Run the project's build / tests / type-check after your changes** and confirm they pass before finishing. If they don't, fix them before exiting.
5. **Do NOT push the branch and do NOT open a pull request.** The orchestrator handles that.
6. **Do NOT modify CONTEXT.md, ADRs, or anything under tools/afk/** unless the issue body explicitly tells you to.
7. **If you discover the issue is wrong / blocked / underspecified**, do not improvise. Make zero commits, then write your finding to a file named \`AFK_BLOCKED.md\` in the worktree root explaining what you discovered and what you'd need to proceed. Then exit.${isRework ? `

# Prior feedback to address

These are the concrete review comments from previous attempts, sorted oldest first. Address each one in this round.

${formatPriorFeedback(priorFeedback)}` : ""}

# When you're done

A clean exit (you finished the task) means: commits are on the branch, build/tests pass, no AFK_BLOCKED.md file exists.

Get to work.`;
}

function formatPriorFeedback(comments: PrComment[]): string {
  return comments.map((c, i) => {
    const date = c.createdAt.split("T")[0] ?? c.createdAt;
    const where = c.kind === "review-comment" && c.path
      ? ` (inline on \`${c.path}\`${c.line ? `:${c.line}` : ""})`
      : c.kind === "review" && c.state
      ? ` (${c.kind}, state: ${c.state})`
      : c.kind === "issue-comment"
      ? " (PR comment)"
      : "";
    return `### ${i + 1}. **${c.author}** — ${date}${where}\n\n${c.body.trim()}`;
  }).join("\n\n---\n\n");
}

export function reviewerPrompt(issue: Issue, diffStats: string): string {
  return `You are a code review agent. You are read-only — you must NOT edit any source files, run formatters, or make commits. Your only write is to a single file: AFK_REVIEW.md in the worktree root.

# What to review

The implementer agent has just finished work on issue #${issue.number} in this worktree. The diff against the base branch:

\`\`\`
${diffStats}
\`\`\`

## Original issue

### #${issue.number}: ${issue.title}

${issue.body}

# Your checklist

For each of the following, take a position and back it with specific file:line references where applicable.

1. **Alignment to the issue.** Does the diff implement what the issue asked for? Anything in scope that's missing? Anything out of scope that was added?
2. **Alignment to CONTEXT.md and ADRs under docs/adr/.** Did the implementer respect locked design decisions? Cite the section/ADR they violated if so.
3. **Code quality.** Look for: dead code, premature abstractions, swallowed errors, broken invariants, magic numbers, unclear naming, comments that explain WHAT instead of WHY, error handling for impossible cases.
4. **Tests, if the issue called for them.** Are they testing external behaviour or implementation details? Do they cover the edge cases the issue described? Did the implementer add tests they weren't asked for (out of scope)?
5. **Build / test status.** Run the project's build and tests yourself. If they fail, that's a request-changes by default.
6. **Subtle bugs.** Race conditions, off-by-ones, error paths that aren't reached, types that lie.

# Output format

Write your verdict to \`AFK_REVIEW.md\` in the worktree root with this exact format:

\`\`\`
verdict: approve
---
<your report in markdown — be specific, cite file:line, name what's good as well as what's wrong>
\`\`\`

OR

\`\`\`
verdict: request-changes
---
<your report in markdown — lead with the most important findings, file:line citations required>
\`\`\`

The first line MUST be exactly \`verdict: approve\` or \`verdict: request-changes\`. The orchestrator parses this deterministically.

# Important

- You are not a rubber stamp. If the implementation is wrong in any of the ways listed above, say so and request changes.
- Do NOT be diplomatic to the point of being unhelpful. Specific findings beat polite generalities.
- If the implementer left an AFK_BLOCKED.md file, write \`verdict: request-changes\` and quote the blocker in your report — the issue itself needs human attention.
- Do not modify any other files. Do not run \`git add\` or \`git commit\`.

Begin the review.`;
}
