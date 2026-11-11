---
description: Show the stored final output for a finished Mistral job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/mistral-companion.mjs" result "$ARGUMENTS"`

Present the full output verbatim. Do not summarize. Preserve job ID, status, partial-result warnings, file paths, line numbers and error messages.
