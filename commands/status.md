---
description: Show active and recent Mistral jobs for this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/mistral-companion.mjs" status "$ARGUMENTS"`

With no job ID: render the output as a single compact Markdown table, preserving job ID, kind, status, elapsed, summary and follow-up commands.
With a job ID: present the full output without condensing it.
