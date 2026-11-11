Treat this request as self-contained — everything needed is below; don't assume access to any
other issue, request or conversation.

## What

An operator keeps a few named agent setups ("presets") — for example "full power", "cheap and
high volume", "Claude is out of limits" — and picks one when starting a run. Presets live in
the operator's home directory, so the same ones work in every repository, and a repository can
add private presets of its own. `jig run --preset` with no name lists the presets with a short
description of each and asks which one to use; `--preset <name>` picks one directly.

## Why

Which agents and models to use depends on the operator, not on the repository: their
subscriptions, their API keys, which limits they have hit today. The repository's
`jig.config.json` should keep what belongs to the project (setup and verify commands, sandbox,
merge mode) and a default set of agents. Today switching agents means editing that file or
keeping whole copies of it per repository and passing `--config <path>`, and the copies drift
apart on everything that is not an agent.

## Context — read this first

jig is a Node/TypeScript CLI (commander, zod, better-result, `@inquirer/prompts`). Layering:
`domain` → `flow`/`steps` → `ports` → `adapters`, wired in `src/app/`; the CLI is in `src/cli/`.
Specs sit beside the code (`load-config.ts` → `load-config.spec.ts`). House rules are in
`.claude/rules/` — read `callee-owns-its-rules.md`, `errors-as-values.md`,
`parse-input-at-the-edge.md` and `testing-conventions.md` before editing.

What exists today:

- `src/config/load-config.ts` parses `jig.config.json` with a strict zod schema. Each step —
  `planner`, `implementer`, `reviewer`, `describer` (the roles are `agentRoleSchema` in
  `src/domain/agent-role.ts`; `byRole` builds one value per role) — is
  `{ provider: 'claude' | 'opencode' | 'codex', model?: string }`. `configFileFor(repoRoot, preset?)`
  resolves which file to read.
- `src/cli/config-option.ts` defines `--config <path>`: a whole config file to read instead of
  `jig.config.json`, relative to the repository root. `init`, `build`, `run` and `status` take
  it. `src/cli/with-app.ts` loads the config once per command and hands it to the container.
- `src/adapters/terminal/` holds the terminal prompts. `askInTerminal` in `terminal.ts` returns
  `undefined` when there is no TTY or the operator cancels; `ask-for-agents.ts` shows how a
  `select` prompt is written and tested.
- `.jig/` in a target repository is jig's scratch and ignores itself (`.jig/.gitignore`).

## Target behaviour

1. **A preset is a file that names agents, nothing else.** `<name>.json` with an optional
   `description` (one line, shown in the prompt) and any of the four steps, in the same
   `{ provider, model? }` shape as the config. The schema is strict: any other key —
   `verifyCommand`, a credential, a typo — is a `ConfigInvalid` naming the file and the key. A
   preset may name only some steps.
2. **Where presets are found**, in this order; the first file with the name wins:
   1. `<repo>/.jig/presets/<name>.json` — this operator, this repository (already git-ignored).
   2. `$XDG_CONFIG_HOME/jig/presets/<name>.json`, falling back to `~/.config/jig/presets/` when
      `XDG_CONFIG_HOME` is unset — this operator, every repository.

   The home directory and `XDG_CONFIG_HOME` are read at the edge (`src/cli/with-app.ts` already
   receives `environment`), not deep inside the config module.
3. **A preset overrides only the steps it names.** Load the base config as today
   (`jig.config.json`, or the `--config` file), then replace each step the preset names. Every
   other key comes from the base config. The config module owns this merge, in a new file
   `src/config/presets.ts` (finding, parsing and applying presets), with its spec beside it;
   callers get one `JigConfig` back. Keep edits to `src/config/load-config.ts` to adding `export`
   to what `presets.ts` needs (e.g. the step schema), and don't edit
   `src/config/load-config.spec.ts`: a parallel request is adding a config-warnings function and
   its specs to those two files.
4. **`--preset [name]`** is added to every command that takes `--config`, next to it in
   `src/cli/config-option.ts`:
   - `--preset <name>`: use that preset. A name that is found in neither directory is an error
     listing the presets that do exist and where jig looked.
   - `--preset` with no name: list every preset from both directories (a repository preset hides
     a home one of the same name) in a `select` prompt — the name as the label, `description` as
     the description — with "jig.config.json (no preset)" as the first choice. Outside a
     terminal, or when the operator cancels, it is an error that says to pass `--preset <name>`.
   - no `--preset`: exactly today's behaviour.
5. **The command logs which preset it used** once, with the file path, from `src/cli/with-app.ts`
   right after the app is created (`app.cradle.logger.info`), so a run's log says which agents
   were picked and from where. Don't edit `src/app/run-jig.ts`: a parallel request adds a
   warning there.
6. **Starter presets ship with jig** in `examples/presets/`, and the README's configuration
   section explains presets, the two directories, and `cp examples/presets/*.json ~/.config/jig/presets/`.
   The starters, verbatim:

   | File | description | planner | implementer | reviewer | describer |
   |---|---|---|---|---|---|
   | `full-power.json` | Subscriptions: best quality, spends Claude most | codex `gpt-6-astra` | claude `opus` | codex `gpt-6.1-sol` | claude `haiku` |
   | `full-power-codex.json` | Subscriptions: best quality, spends Codex most | claude `opus` | codex `gpt-6.1-sol` | claude `opus` | codex `gpt-6-luna` |
   | `long-claude.json` | Subscriptions: many slices, Sonnet stretches the Claude window | claude `opus` | claude `sonnet` | codex `gpt-6.1-sol` | claude `haiku` |
   | `codex-only.json` | Claude is out of limits | codex `gpt-6-astra` | codex `gpt-6.1-sol` | codex `gpt-6-astra` | codex `gpt-6-luna` |
   | `claude-only.json` | Codex is out of limits | claude `opus` | claude `sonnet` | claude `opus` | claude `haiku` |
   | `cheap-volume.json` | Pay-per-token: open-weight implementer, strong reviewer | codex `gpt-6.1-sol` | opencode `openrouter/z-ai/glm-5.3` | claude `opus` | opencode `openrouter/deepseek/deepseek-v4.1-flash` |
   | `open-weight.json` | Both subscriptions are out; simpler requests only | opencode `openrouter/moonshotai/kimi-k3` | opencode `openrouter/z-ai/glm-5.3` | opencode `openrouter/deepseek/deepseek-v4-pro` | opencode `openrouter/deepseek/deepseek-v4.1-flash` |

   The OpenRouter model ids were not checked against OpenRouter's live listing; check each one
   and correct it in the file if the id differs, and say so in the PR. Note in the README that
   `gpt-6-astra` may not be in every Codex plan and `gpt-6.1-sol` is its stand-in.
7. **This repository uses it too.** `jig.config.json` at the root keeps the project keys and the
   default agents (`full-power`'s steps). Delete `jig.config.glm-impl.json` from the root if it
   exists; its setup is covered by `cheap-volume.json`.

## Don't undo these

- `--config <path>` stays, with its current meaning; `--preset` layers on top of it.
- The config schema stays `.strict()`, and so does the preset schema: an unknown key is an error,
  never silently ignored.
- A preset never holds credentials. Credentials come from the environment or `.jig/.env` only.
- jig never writes into a target repository's tracked files: presets are read from `.jig/presets/`
  (ignored) and the home directory, never from a tracked path.
- An expected failure (missing preset, invalid file, no terminal) is an `Err`; nothing throws.

## How to work

From the repo root:

```sh
npm run validate -- --skip test:mutation
```

Mutation testing takes 20+ minutes; skip it.

## Done when

- [ ] `src/config/presets.spec.ts` covers: a preset overriding some steps and keeping the rest; a
      repository preset hiding a home preset of the same name; `XDG_CONFIG_HOME` set and unset;
      an unknown key rejected; a missing name reported with the presets that exist
- [ ] a spec in `src/adapters/terminal/` covers the preset prompt: descriptions shown, the
      "no preset" choice, cancel, no TTY
- [ ] `src/cli/` specs cover `--preset <name>`, bare `--preset`, and `--preset` with `--config`
- [ ] `examples/presets/` holds the seven files above, each valid against the preset schema
      (a spec loads all of them)
- [ ] the README documents presets
- [ ] `npm run validate -- --skip test:mutation` passes
