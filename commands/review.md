---
description: Run a Mistral Vibe code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <alias>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a read-only Mistral Vibe review.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only. Do not fix issues or apply patches.
- Your only job is to run the review and return Mistral's output verbatim.

Execution mode rules:
- If the arguments include `--wait`, run in the foreground without asking.
- If the arguments include `--background`, run as a Claude background task without asking.
- Otherwise estimate size first (`git status --short --untracked-files=all`, `git diff --shortstat --cached`, `git diff --shortstat`, or `git diff --shortstat <base>...HEAD` for a branch review; untracked files count as reviewable). Recommend waiting only for a clearly tiny change (1-2 files); otherwise recommend background. If there is nothing to review, say so.
- Then use `AskUserQuestion` exactly once with options `Wait for results` and `Run in background`, recommended one first with a `(Recommended)` suffix.

Argument handling:
- Pass the user's arguments through exactly; do not strip `--wait` or `--background`.
- This command takes no focus text. For custom focus use `/mistral:adversarial-review`.

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mistral-companion.mjs" review "$ARGUMENTS"
```
Return stdout verbatim. Do not summarize, and do not fix anything the review mentions.

Background flow: launch the same command with `Bash` using `run_in_background: true`, then tell the user: "Mistral review started in the background. Check `/mistral:status` for progress."
