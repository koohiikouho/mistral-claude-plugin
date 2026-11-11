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
| `/mistral:setup` | Check that Vibe is installed and can run headless |

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
- `--wait` / `--background`: run in the foreground, or as a Claude Code background task. Without either, Claude asks based on the size of the change.

### Rescue options
- `--resume` / `--fresh`: continue the last Vibe session for this repo, or start a new one.
- `--model <alias>`: use a specific Vibe model alias.
- `--background` / `--wait`: as above.

Rescue runs go through the `mistral:mistral-rescue` subagent. Claude can also call that subagent on its own when it is stuck.

## Choosing a model

The plugin passes `--model <alias>` straight to `vibe`, so any model alias Vibe knows works, including models from Mistral's hosted catalog such as `deepseek@mistral`:

```
/mistral:rescue --model deepseek@mistral investigate the flaky test
/mistral:review --model deepseek@mistral
```

To change the default for every command, set `active_model` in `~/.vibe/config.toml`. `--model` only applies to new sessions; a resumed rescue session keeps its original model.

## How it works

- **Reviews** run `vibe --agent ask`. Vibe can read files but its write and shell tools are denied. The diff is placed in the prompt (size-capped). Untracked files are included for working-tree reviews only, not for `--scope branch`.
- **Rescue** runs use `vibe --auto-approve`, which lets Vibe edit files and run commands without asking. A headless run cannot answer approval prompts, so there is no in-between mode. Only use rescue in repositories where you are comfortable with that.
- Prompts are passed with `--prompt-file`, so large diffs do not hit command-line limits.
- Each run is recorded as a job under the plugin data directory (`~/.cache/mistral-companion` if run outside Claude Code). Stop reason, token usage and session id come from Vibe's `--output-dir` export.
- Runs stopped by a turn or time limit are shown as **partial** instead of success. Jobs default to a 30 minute and 60 turn cap.
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
