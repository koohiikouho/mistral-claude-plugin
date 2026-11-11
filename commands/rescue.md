---
description: Delegate investigation, an explicit fix request, or follow-up work to the Mistral rescue subagent
argument-hint: '[--background|--wait] [--resume|--fresh|--resume-job <job-id>] [--model <alias>] [--effort <level>] [--compact-at <tokens>] [--max-turns <n>] [--time-limit <s>] [--max-tokens <n>] [what Mistral should investigate, solve, or continue]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `mistral:mistral-rescue` subagent via the `Agent` tool (`subagent_type: "mistral:mistral-rescue"`), forwarding the raw user request as the prompt.
`mistral:mistral-rescue` is a subagent, not a skill. Do not call `Skill(mistral:mistral-rescue)` (no such skill) or `Skill(mistral:rescue)` (that re-enters this command and hangs the session).
The final user-visible response must be Mistral's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:
- `--background`: run the subagent in the background. `--wait` or neither: foreground.
- `--background` and `--wait` are Claude Code execution flags; do not forward them as task text. `--model`, `--effort`, `--compact-at`, `--max-turns`, `--time-limit`, `--max-tokens`, `--no-wrap-up` and `--resume-job <id>` are runtime flags; preserve them for the forwarded `task` call.
- With `--resume`, `--fresh` or `--resume-job`, do not ask; the user already chose.
- Otherwise run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mistral-companion.mjs" task-resume-candidate --json
```
- If it reports `available: true`, ask once with `AskUserQuestion`: `Continue current Mistral session` / `Start a new Mistral session`. Put the continue option first (with `(Recommended)`) only when the user is clearly following up ("continue", "keep going", "dig deeper"); otherwise put the new-session option first. Add `--resume` or `--fresh` accordingly.
- If `available: false`, do not ask.

Operating rules:
- The subagent is a thin forwarder: one `Bash` call to `mistral-companion.mjs task ...`, stdout returned as-is.
- Do not paraphrase or add commentary. Do not ask the subagent to poll status, fetch results or cancel.
- If Vibe is missing or not configured, stop and tell the user to run `/mistral:setup`.
- If no request was supplied, ask what Mistral should investigate or fix.
