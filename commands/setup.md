---
description: Check whether the local Mistral Vibe CLI is ready
argument-hint: '[--fix-vibe]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mistral-companion.mjs" setup $ARGUMENTS
```

Present the output to the user as-is. If Vibe is installed but a headless run failed, preserve the guidance to run `!vibe --setup`. If `vibe` is not found, point the user to the Mistral Vibe install docs; do not install anything yourself.

`--fix-vibe` edits the user's installed Vibe (one line, with a `.orig` backup). Pass it only when the user typed it.
