# Mistral plugin for Claude Code

Use [Mistral Vibe](https://docs.mistral.ai/) from inside Claude Code to review code or delegate tasks.
Inspired by [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Wraps the headless `vibe` CLI.

## Requirements
- Claude Code, Node 18.18+, and `vibe` on your PATH (configured via `vibe --setup`).

## Install
```
/plugin marketplace add <path-or-github-url-of-this-repo>
/plugin install mistral@mistral-vibe
/reload-plugins
/mistral:setup
```

## Commands
| Command | What it does |
|---|---|
| `/mistral:review` | Read-only review of working-tree or branch changes (`--base`, `--scope`, `--wait`, `--background`) |
| `/mistral:adversarial-review [focus]` | Review that challenges design and assumptions |
| `/mistral:rescue [task]` | Hand a task to Vibe via the `mistral:mistral-rescue` subagent (write-capable; `--resume`/`--fresh`, `--model`) |
| `/mistral:status [id]` | Show jobs |
| `/mistral:result [id]` | Show a finished job's output |
| `/mistral:cancel [id]` | Kill a running job |
| `/mistral:setup` | Check Vibe is installed and can run headless |

## How it works
Reviews run `vibe --agent ask` (read tools allowed, writes denied) with the diff (including untracked files, size-capped) in the prompt. Rescue runs use `--auto-approve`, so Vibe may edit files and run commands. Prompts go through `--prompt-file`; the stop reason and token usage come from the `--output-dir` export. Runs stopped by a turn or time limit are shown as **partial**. Jobs have a default 30 min / 60 turn cap.

## Not included (vs. the Codex plugin)
Stop-time review gate and session transfer; structured JSON review output (Vibe has no output-schema flag, so reviews are Markdown).

License: Apache-2.0 (see NOTICE).
