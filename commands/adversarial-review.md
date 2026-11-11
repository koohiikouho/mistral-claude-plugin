---
description: Run a Mistral Vibe review that challenges the chosen approach and design
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <alias>] [--compact-at <tokens>] [--brief] [focus ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a read-only adversarial Mistral Vibe review.

Raw slash-command arguments:
`$ARGUMENTS`

Rules: identical to `/mistral:review` (review-only, no preliminary commands or questions, foreground unless `--background`, return stdout verbatim). Text after the flags is focus text (for example "look for race conditions") and is forwarded to Mistral.

Foreground:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mistral-companion.mjs" adversarial-review "$ARGUMENTS"
```

If the arguments include `--background`: same command via `Bash` with `run_in_background: true`, then tell the user: "Mistral adversarial review started in the background. Check `/mistral:status` for progress."
