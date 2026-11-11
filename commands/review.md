---
description: Run a Mistral Vibe code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <alias>] [--effort <level>] [--compact-at <tokens>] [--brief]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a read-only Mistral Vibe review.

Raw slash-command arguments:
`$ARGUMENTS`

Rules (keep this turn cheap):
- Review-only. Do not fix issues, apply patches, or run any other command first (no git estimates, no questions).
- Pass the arguments through exactly. Without `--background`, run in the foreground.
- Return the command's stdout verbatim. Do not summarize or re-read files it mentions.
- Reviews return Mistral's complete output. `--brief` asks for a short version (top 7 findings, one line each, printed output capped).

Foreground:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mistral-companion.mjs" review "$ARGUMENTS"
```

If the arguments include `--background`: run the same command with `Bash` using `run_in_background: true`, then tell the user: "Mistral review started in the background. Check `/mistral:status` for progress."
