# Agent presets

[Documentation](README.md) · [Project home](../README.md)

Presets replace agents without changing the rest of your [config](configuration.md):

```bash
jig presets
jig run request.md --preset cheap-volume
jig build --preset
```

## Discovery and precedence

A preset is a `<name>.json` file. jig searches these locations in order:

1. `.jig/presets/` in the target repository.
2. `~/.jig/presets/`.
3. `$XDG_CONFIG_HOME/jig/presets/`, or `~/.config/jig/presets/` when unset.
4. The [starters shipped with jig](../presets/), listed as `builtin`.

The first matching name wins. An invalid file fails rather than falling back to another
copy. Names use lowercase letters and digits joined by single hyphens. A preset accepts
an optional `description` and any of the four agent roles: `planner`, `implementer`,
`reviewer`, and `describer`. Each supplied role replaces that role's entire config,
including its model. Other settings keep their config values.

A bare `--preset` opens a picker. Its first entry keeps the selected config's agents;
the remaining entries show presets, their descriptions, and any custom source.
Without a terminal, or if the prompt is cancelled, pass an explicit name.
Put a bare `--preset` after the request: `jig run request.md --preset`. Otherwise,
the CLI treats the request path as the preset name. Use the same preset when resuming.

## Built-in presets

Each starter configures all four roles:

- `full-power` — Claude implements and describes; Codex plans and reviews.
- `full-power-codex` — Codex implements and describes; Claude plans and reviews.
- `long-claude` — Claude Sonnet implements; Codex reviews.
- `codex-only` — Codex handles all roles.
- `claude-only` — Claude handles all roles.
- `cheap-volume` — OpenCode implements and describes; Codex plans and Claude reviews.
- `codex-reviewed-opencode` — OpenCode implements and describes; Codex plans and reviews.
- `open-weight` — OpenCode handles all roles through OpenRouter.

The [starter files](../presets/) show the exact models. If a model is unavailable to your account,
copy its preset to `~/.jig/presets/` under the same name and choose a model you can use.

## Create a preset

To override one role, save a preset such as `~/.jig/presets/my-reviewer.json`:

```json
{
  "description": "Use Claude for review",
  "reviewer": { "provider": "claude", "model": "opus" }
}
```

Use it with `jig run request.md --preset my-reviewer`. Other roles and settings come
from the selected config. Files under `.jig/` are ignored, so use a home preset for
personal settings and distribute shared presets separately.
