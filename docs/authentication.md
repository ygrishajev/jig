# Authentication

[Documentation](README.md) · [Project home](../README.md)

Configure credentials for every agent used by your config or preset before building
or running. In a terminal, `jig init` prompts for missing credentials; other commands
and noninteractive invocations stop and name the missing variables.

## Agent credentials

| Agent       | Configuration                                           | Credential                                                                                   |
| ----------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Claude Code | `"provider": "claude"`                                  | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`                                             |
| OpenCode    | `"provider": "opencode"`, with a `provider/model` model | The model provider's API key, such as `OPENROUTER_API_KEY` for `openrouter/...`              |
| Codex       | `"provider": "codex"`, with an explicit model           | `JIG_CODEX_AUTH_DIR`, pointing to a directory containing a saved ChatGPT login (`auth.json`) |

Choose agents and models in [configuration](configuration.md) or an [agent preset](presets.md).

## Credential storage

jig reads credentials from the environment first, then from `.jig/.env` for variables
not set in the environment. Only credentials are read from that file.

When you agree at the `jig init` prompt, jig saves credentials to `.jig/.env` with
owner-only permissions. `.jig/.gitignore` excludes the file from Git. Keep all `.env`
files ignored and credentials out of config files and Dockerfiles.

Credentials enter the container as environment variables, except for the private
Codex login copy described below. Sandcastle also injects keys listed in
`.sandcastle/.env` if that file exists; jig warns with their names.

## Codex authentication

Codex authentication is an explicit exception to the usual env-only credential rule.
The production CLI accepts the auth directory through `JIG_CODEX_AUTH_DIR`; it does not
auto-discover a host login. The adapter locks that login, creates a private temporary
directory with only `auth.json` (file mode 0600), and mounts the directory writable at
`/home/agent/.codex`. No other host Codex configuration or sessions are mounted. Codex
can refresh credentials normally. After the sandbox closes, valid refreshed credentials
are atomically written back to the selected cache, and the private copy is removed.
If the source login changed meanwhile, it is preserved and the private cache is retained
with an error rather than overwriting the newer login. Credentials never enter repository
artifacts, logs, or Docker image layers. Do not share a login across concurrent jobs or
machines; jig's lock cannot coordinate with independent Codex clients.

The production CLI requires `JIG_CODEX_AUTH_DIR` even if you are already logged in
on the host. To select the usual login directory:

```bash
export JIG_CODEX_AUTH_DIR="$HOME/.codex"
```

The [live E2E test](testing.md#agent-credentials) has separate login-discovery behavior.
