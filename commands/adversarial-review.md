---
description: Run a Mistral Vibe review that challenges the chosen approach and design
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a read-only adversarial Mistral Vibe review.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- Review-only. Do not fix issues or apply patches. Return Mistral's output verbatim.

Execution mode rules: identical to `/mistral:review` (honor `--wait` / `--background`; otherwise estimate size, then ask once with `Wait for results` / `Run in background`, recommended first).

Argument handling:
- Pass arguments through exactly. Any text after the flags is focus text (for example "look for race conditions") and is forwarded to Mistral.

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mistral-companion.mjs" adversarial-review "$ARGUMENTS"
```
Return stdout verbatim.

Background flow: same command via `Bash` with `run_in_background: true`, then tell the user: "Mistral adversarial review started in the background. Check `/mistral:status` for progress."
