# Mistral plugin for Claude Code

Use [Mistral Vibe](https://docs.mistral.ai/) from inside Claude Code to get a second opinion on your code or hand a task off to Vibe.

It is a port of the idea behind [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) for the `vibe` CLI. The plugin is a thin wrapper around headless `vibe` runs, so anything Vibe is configured to do (model, API key, MCP servers) carries over.

## Requirements
- [Claude Code](https://claude.com/claude-code)
- Node.js 18.18 or newer
- The `vibe` CLI on your `PATH`, with an API key configured (`vibe --setup`)

## Install

```
/plugin marketplace add koohiikouho/mistral-claude-plugin
/plugin install mistral@mistral-vibe
/reload-plugins
/mistral:setup
```

`/mistral:setup` runs a tiny headless Vibe call and tells you whether everything works. If it fails, run `!vibe --setup` and try again.

## Commands

| Command | What it does |
|---|---|
| `/mistral:review` | Read-only review of your working tree or a branch diff |
| `/mistral:adversarial-review [focus]` | A review that challenges the design, assumptions and failure modes |
| `/mistral:rescue [task]` | Hand a debugging or implementation task to Vibe |
| `/mistral:status [job-id]` | List jobs for this repo, or show one |
| `/mistral:result [job-id]` | Show the stored output of a finished job |
| `/mistral:cancel [job-id]` | Stop a running job |
| `/mistral:setup [--fix-vibe]` | Check that Vibe is installed and can run headless; `--fix-vibe` patches a Vibe write stall on Windows |

### Examples

```
/mistral:review
/mistral:review --base main --background
/mistral:adversarial-review --scope branch look for race conditions and retry storms
/mistral:rescue --write investigate why the integration test is flaky
/mistral:rescue --resume apply the top fix
/mistral:status
/mistral:result
```

### Review options
- `--scope auto|working-tree|branch`: `auto` reviews your uncommitted changes if there are any, otherwise the current branch against its base.
- `--base <ref>`: the branch to diff against (defaults to `origin/HEAD`, then `main` or `master`).
- `--model <alias>`: run the review with a specific Vibe model (see below).
- `--effort <level>`: reasoning effort (`off|low|medium|high|xhigh|max`); see below.
- `--compact-at <tokens>`: token count at which Vibe compacts (summarizes) the session; see below.
- `--wait` / `--background`: run in the foreground (the default), or as a Claude Code background task.
- `--brief`: ask for a short review (top 7 findings, one line each; printed output capped). Reviews are full-length by default.

### Rescue options
- `--resume` / `--fresh`: continue the last Vibe session for this repo, or start a new one.
- `--model <alias>`: use a specific Vibe model alias.
- `--effort <level>` and `--compact-at <tokens>`: see below.
- `--background` / `--wait`: as above.

Rescue runs go through the `mistral:mistral-rescue` subagent. Claude can also call that subagent on its own when it is stuck.

## Choosing a model

The plugin passes `--model <alias>` straight to `vibe`, so any model alias Vibe knows works, including models from Mistral's hosted catalog such as `deepseek@mistral`:

```
/mistral:rescue --model deepseek@mistral investigate the flaky test
/mistral:review --model deepseek@mistral
```

DeepSeek models (any alias containing `deepseek`) run at **max reasoning** by default; pass `--effort` to choose another level (`off|low|medium|high|max`). Vibe has no flag for this, so the plugin sets it for that run only through the `VIBE_MODELS` environment variable; your config files are not touched. If you set `active_model` to a DeepSeek alias in `config.toml` and omit `--model`, pass `--model` anyway to get max reasoning.

### Reasoning effort (`--effort`)

`--effort <level>` sets the model's reasoning (Vibe calls it `thinking`) for one run: `off`, `low`, `medium`, `high`, `xhigh` or `max`. Each model supports its own subset, for example GLM-5.3 takes `low|high|max`. The plugin checks the level against the model and refuses an unsupported one up front instead of letting the API return an error. It needs to know the model, so pass `--model <alias>` unless `active_model` is set in your config. The first use runs one tiny probe call to read Vibe's model list (cached for an hour). DeepSeek defaults to `max` when `--effort` is omitted.

```
/mistral:review --model glm-5-3 --effort low
```

### Compaction (`--compact-at`)

`--compact-at <tokens>` (1000 to 10000000) sets how large a session's context may grow before Vibe compacts it. Lower values compact sooner and keep long runs cheaper; higher values keep more history. It does not enlarge the model's context window: Vibe moves a threshold the window cannot support back into range, with a warning. The plugin sets it with the `VIBE_AUTO_COMPACT_THRESHOLD` environment variable, which Vibe applies only to models that have no threshold of their own. DeepSeek, and any model run with `--effort`, is always covered. For another model that already carries its own threshold (several catalog models do), set `auto_compact_threshold` for that model in `~/.vibe/config.toml` instead.

To change the default for every command, set `active_model` in `~/.vibe/config.toml`. `--model` only applies to new sessions; a resumed rescue session keeps its original model.

## Saving tokens

The defaults are tuned for using Vibe alongside Claude:

- **No preliminary turns.** `/mistral:review` runs immediately; Claude does not run size estimates or ask a question first.
- **Full reviews, short rescue replies.** Reviews return everything Mistral says; add `--brief` when you want only the top findings. Rescue runs reply with a short summary and a `git diff --stat` of what changed (printed output capped at about 4000 characters; `--full` on the command, or `/mistral:result <id> --full`, returns everything).
- **Smaller review input.** Lockfiles, minified files, source maps and snapshots are left out of the diff, and the review input is capped at 100 KB.
- **Fewer turns.** Reviews stop after 15 turns by default (`--max-turns` to change).
- **Pick a cheaper model** for routine work with `--model`.

## Stuck runs

While a job runs, the plugin watches Vibe's session journal and records the latest action. `/mistral:status <job-id>` shows it as `Last activity: <action> (<n>s ago)`, so you can tell a working run from a stuck one even though the output stays empty until the run ends. Vibe's `--time-limit` (default 1800 seconds) ends a stuck run. As a backstop, the plugin kills the Vibe process tree if it is still running 120 seconds after the limit, and reports the last journal activity and session id in the error.

**Known Vibe issue (Windows):** a `write_file` that creates a *new* file stalls until the time limit when the folder is in a git repository with a `.gitattributes` file, or in a linked git worktree. The file is written only when the run ends. Vibe runs `git check-attr` to choose the new file's line ending, without closing stdin. In Vibe's app server that git process stalls before it starts, and the 5-second timeout cannot free it, because it kills only Git for Windows' `cmd\git.exe` launcher. Edits to existing files are not affected. `/mistral:setup` checks for this, and `/mistral:setup --fix-vibe` patches your installed Vibe: it adds `stdin=subprocess.DEVNULL` to that one git call and keeps the original as `_sandbox_helper.py.orig`. Updating Vibe undoes the patch, so run `/mistral:setup` again after an update. The check covers Vibe installed with `uv tool`; if setup cannot find the file, the stuck run ends at its time limit, and `/mistral:status` shows `Running file_system.write_file` with a growing age.

## How it works

- **Reviews** run `vibe --agent ask`. Vibe can read files but its write and shell tools are denied. The diff is placed in the prompt (size-capped). Untracked files are included for working-tree reviews only, not for `--scope branch`.
- **Rescue** runs use `vibe --auto-approve`, which lets Vibe edit files and run commands without asking. A headless run cannot answer approval prompts, so there is no in-between mode. Only use rescue in repositories where you are comfortable with that.
- Prompts are passed with `--prompt-file`, so large diffs do not hit command-line limits.
- Each run is recorded as a job under the plugin data directory (`~/.cache/mistral-companion` if run outside Claude Code). Stop reason, token usage and session id come from Vibe's `--output-dir` export.
- Runs stopped by a turn or time limit are shown as **partial** instead of success. Tasks default to a 30 minute and 60 turn cap; reviews to 15 turns.
- `/mistral:cancel` kills the whole Vibe process tree.

## Differences from the Codex plugin
- No stop-time review gate and no session transfer.
- Reviews are returned as Markdown, not structured JSON, because Vibe has no output-schema option.

## Development

The runtime is one dependency-free file, `scripts/mistral-companion.mjs`. You can drive it directly:

```
node scripts/mistral-companion.mjs setup
node scripts/mistral-companion.mjs review --scope working-tree
node scripts/mistral-companion.mjs task --write "do the thing"
node scripts/mistral-companion.mjs status
```

Run the unit tests with `npm test` (Node built-in test runner, no dependencies; needs Node 21+ for the glob in the test script) and validate the manifests with `claude plugin validate .`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The command layout and job model follow `openai/codex-plugin-cc` (Apache-2.0, Copyright 2026 OpenAI).
