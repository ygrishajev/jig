Treat this request as self-contained — everything needed is below; don't assume access to any
other issue, request or conversation.

## What

Two additions to agent presets, the named agent setups an operator picks per run:

1. **A picker.** `jig run request.md --preset` with no name lists every preset with its
   description and asks which one to use, with "no preset" as the first choice.
2. **Starter presets that ship with jig.** Seven ready-made presets come with the package, so a
   new operator has something to pick from with no setup. An operator's own preset with the same
   name replaces a starter.

## Why

Presets exist, but `--preset` needs an exact name, so an operator has to run `jig presets` first,
read the list, and type the name back. And a fresh install has no presets at all: every operator
has to work out good agent combinations themselves and write the files by hand.

## Context — read this first

jig is a Node/TypeScript CLI (commander, zod, better-result, `@inquirer/prompts`). Layering:
`domain` → `flow`/`steps` → `ports` → `adapters`, wired in `src/app/`; the CLI is in `src/cli/`.
Specs sit beside the code (`presets.ts` → `presets.spec.ts`). House rules are in
`.claude/rules/` — read `callee-owns-its-rules.md`, `errors-as-values.md`,
`parse-input-at-the-edge.md` and `testing-conventions.md` before editing.

How presets work today:

- `src/config/presets.ts` owns them. A preset is `<name>.json` holding an optional `description`
  and any of `planner`, `implementer`, `reviewer`, `describer`, each `{ provider, model? }`
  (strict schema). `PRESET_SOURCES = ['repository', 'home', 'xdg']` is the lookup order:
  `<repo>/.jig/presets/`, `~/.jig/presets/`, then `$XDG_CONFIG_HOME/jig/presets/` (or
  `~/.config/jig/presets/`). The first file with a name wins and hides the others
  (`shadowedRemoved`). `discoverPresets` lists them all; `loadPreset` reads one by name;
  `configWithPreset` applies one to the project config.
- `src/cli/config-option.ts` defines `--preset <name>` (`presetOption`, `presetInputSchema` with
  `presetNameSchema`). `jig run` and `jig build` take it.
- `src/cli/with-app.ts` loads the config and applies the preset **before** the app container
  exists, so a prompt there cannot come from the container. `withApp` already takes an
  `Invocation` (`cwd`, `environment`) as its third argument so specs can pass their own.
- `src/cli/commands/presets.ts` is `jig presets`: name, source, path and description of each.
- `src/adapters/terminal/terminal.ts` has `askInTerminal`, which returns `undefined` with no TTY
  or when the operator cancels. `src/adapters/terminal/ask-for-agents.ts` shows how a `select`
  prompt is written; its spec shows how one is tested.
- `package.json` publishes only `dist` (`"files": ["dist"]`); the CLI runs from
  `dist/cli/main.js`, and in development from `src/cli/main.ts` via `npm run dev`.

## Target behaviour

### 1. The picker

- `--preset` takes an optional value: `--preset [name]` in commander. With a name, behaviour is
  unchanged. With no name, the input schema yields "ask" rather than a name (parse it at the
  edge into a typed value; don't pass commander's `true` around).
- Add `src/adapters/terminal/ask-for-preset.ts`: given the discovered presets, a `select` with
  "jig.config.json (no preset)" first, then one choice per preset — the name as the label, the
  description as the choice's `description`, and the source in the label when it is not a
  starter (e.g. `long-claude (home)`). It returns the chosen preset name, "none", or `undefined`
  (no TTY, cancelled) via `askInTerminal`.
- `withApp` gets the ask function through `Invocation`, defaulting to the process terminal, so
  specs pass a fake. When asked to ask: discover presets, ask, then continue exactly as if that
  name (or no preset) had been passed. `undefined` is a `ConfigInvalid` saying to pass
  `--preset <name>` and to run `jig presets` to see them. No presets at all is the same error,
  without asking.
- The log line that says which preset a command used stays as it is and covers a picked preset
  too.

### 2. Starter presets

- The seven files live in `presets/` at the repository root and ship in the package: add
  `"presets"` to `"files"` in `package.json`. Resolve the folder from the module's own location
  (`import.meta.url`), so it works from both `src/` under `npm run dev` and `dist/` when
  installed.
- Add `'builtin'` as the **last** entry of `PRESET_SOURCES`. Discovery, shadowing, `loadPreset`
  and the "not found" message treat it like any other directory; an operator's file with the
  same name hides the starter. `jig presets` shows the source as `builtin`.
- The starters, verbatim (`provider` then `model`; OpenRouter ids were checked against
  OpenRouter's live model list on 2026-11-11):

| File | description | planner | implementer | reviewer | describer |
|---|---|---|---|---|---|
| `full-power.json` | Subscriptions: best quality, spends Claude most | codex `gpt-6-astra` | claude `opus` | codex `gpt-6.1-sol` | claude `haiku` |
| `full-power-codex.json` | Subscriptions: best quality, spends Codex most | claude `opus` | codex `gpt-6.1-sol` | claude `opus` | codex `gpt-6-luna` |
| `long-claude.json` | Subscriptions: many slices, Sonnet stretches the Claude window | claude `opus` | claude `sonnet` | codex `gpt-6.1-sol` | claude `haiku` |
| `codex-only.json` | Claude is out of limits | codex `gpt-6-astra` | codex `gpt-6.1-sol` | codex `gpt-6-astra` | codex `gpt-6-luna` |
| `claude-only.json` | Codex is out of limits | claude `opus` | claude `sonnet` | claude `opus` | claude `haiku` |
| `cheap-volume.json` | Pay-per-token: open-weight implementer, strong reviewer | codex `gpt-6.1-sol` | opencode `openrouter/z-ai/glm-5.3` | claude `opus` | opencode `openrouter/deepseek/deepseek-v4.1-flash` |
| `open-weight.json` | Both subscriptions are out; simpler requests only | opencode `openrouter/moonshotai/kimi-k3` | opencode `openrouter/z-ai/glm-5.3` | opencode `openrouter/deepseek/deepseek-v4-pro` | opencode `openrouter/deepseek/deepseek-v4.1-flash` |

  Each file is `{ "description": ..., "planner": { "provider": ..., "model": ... }, ... }` with
  all four steps.

### 3. README

In the configuration section: the picker, the `builtin` source and that an operator's file of
the same name replaces a starter, the seven starters with one line each, and that
`gpt-6-astra` may not be in every Codex plan — `gpt-6.1-sol` is its stand-in.

## Don't undo these

- `--preset <name>` and `--config <path>` keep their meaning; no `--preset` is today's behaviour.
- The preset schema stays `.strict()`; starters pass the same schema as an operator's files.
- A preset found earlier hides later ones even when it is broken — a broken operator file must
  not silently fall back to the starter of the same name.
- Nothing is written to the operator's home directory or the target repository: starters are
  read from the package, never copied.
- An expected failure (no TTY, cancel, no presets) is an `Err`; nothing throws.

## How to work

From the repo root:

```sh
npm run validate -- --skip test:mutation
```

Mutation testing takes 20+ minutes; skip it. To see the picker by hand:
`npm run dev -- build --preset`.

## Done when

- [ ] `src/adapters/terminal/ask-for-preset.spec.ts` covers: descriptions shown, the "no preset"
      choice, a preset picked, cancel, no TTY
- [ ] `src/cli/` specs cover `--preset` with a name, bare `--preset` (picked, "no preset",
      unanswered), and bare `--preset` with no presets
- [ ] `src/config/presets.spec.ts` covers: starters listed as `builtin`; an operator file hiding
      a starter of the same name; a broken operator file not falling back to the starter
- [ ] a spec loads every file in `presets/` against the preset schema
- [ ] `npm pack --dry-run` lists the seven `presets/*.json` files
- [ ] the README documents the picker and the starters
- [ ] `npm run validate -- --skip test:mutation` passes
