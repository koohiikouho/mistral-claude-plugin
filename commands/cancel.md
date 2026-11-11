---
description: Cancel an active background Mistral job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/mistral-companion.mjs" cancel "$ARGUMENTS"`
