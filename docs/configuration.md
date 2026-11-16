# Configuration

[Documentation](README.md) · [Project home](../README.md)

jig reads `jig.config.json` from the repository root. Unknown top-level keys are errors.

`init`, `build`, `run`, and `status` accept `--config <path>` to select a different file:
`jig run request.md --config jig.config.cheap.json`. Relative paths resolve from the
repository root. A named file must exist. Use the same file when resuming.

## Example config

This example uses Claude for all four roles. Set `verifyCommand` to the checks your
project actually runs. jig warns when the reviewer and implementer use the same model,
or when no verification command is configured.

```json
{
  "planner": { "provider": "claude", "model": "opus" },
  "implementer": { "provider": "claude", "model": "sonnet" },
  "reviewer": { "provider": "claude", "model": "opus" },
  "describer": { "provider": "claude", "model": "haiku" },
  "setupCommand": "npm ci",
  "verifyCommand": "npm test",
  "designGate": "checkpoint",
  "mergeMode": "manual"
}
```

## Agent roles

All four roles are required to run or build. Each specifies a `provider` and, where required, a `model`:

| Role          | Purpose                                                        |
| ------------- | -------------------------------------------------------------- |
| `planner`     | Plans the change, writes design documents, and defines slices. |
| `implementer` | Implements slices and responds to review feedback.             |
| `reviewer`    | Reviews the design, individual slices, and the whole change.   |
| `describer`   | Writes the pull request description.                           |

Providers are `claude`, `opencode`, and `codex`. Claude defaults to model `opus` when
omitted. OpenCode requires a `provider/model` model name; Codex requires an explicit
model. See [authentication](authentication.md) for their credentials.

Use [agent presets](presets.md) to replace one or more roles without changing other
settings. The `agents` setting below pins CLI versions, not models.

## Verification and run policy

| Key              | Default    | Behavior                                                                                                       |
| ---------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `verifyCommand`  | Not set    | Runs before slice review and during the final check; must pass for approval. Required to skip the final check. |
| `mergeMode`      | `"manual"` | `manual` waits for you to merge; `auto` merges the run branch.                                                 |
| `designGate`     | `"auto"`   | `checkpoint` pauses after design review and slicing, before implementation.                                    |
| `reviewCycleCap` | `3`        | Positive integer; ordinary rejections before a slice is stuck.                                                 |
| `commitSigning`  | `"skip"`   | `repo` re-signs the run branch during automatic merging.                                                       |

See [the pipeline](commands.md#pipeline) for review limits and
[merging and signing](sandbox.md#merging-and-signing) for merge behavior.

## Sandbox and agent CLIs

| Key                       | Default  | Behavior                                                                                 |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `setupCommand`            | Not set  | Runs once in each new sandbox before any agent, for example `npm ci`.                    |
| `setupTimeoutSeconds`     | `900`    | Positive integer; setup time limit in seconds.                                           |
| `sandboxImage`            | Not set  | Uses the supplied image as-is instead of building one.                                   |
| `agents`                  | `{}`     | Pins exact CLI versions by provider, for example `{ "claude": "2.1.312" }`.              |
| `agentUpdates`            | `"auto"` | `auto` rebuilds for new unpinned releases; `warn` only reports them; `off` skips checks. |
| `agentIdleTimeoutSeconds` | `600`    | Positive integer; stops an agent after this many seconds without output.                 |

`jig build --pull-agents` refreshes unpinned CLIs even when updates are off.
See [images and setup](sandbox.md#images-and-setup) for the container lifecycle.

## State storage

`runStores` defaults to `["local"]` and must contain at least one entry. Add
`"git-remote"` to push state and the run branch to `origin`, or supply a path to a
custom store module. See [saved state and remote resume](operations.md#saved-state-and-remote-resume).
