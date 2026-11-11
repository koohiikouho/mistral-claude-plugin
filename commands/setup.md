---
description: Check whether the local Mistral Vibe CLI is ready
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mistral-companion.mjs" setup
```

Present the output to the user as-is. If Vibe is installed but a headless run failed, preserve the guidance to run `!vibe --setup`. If `vibe` is not found, point the user to the Mistral Vibe install docs; do not install anything yourself.
