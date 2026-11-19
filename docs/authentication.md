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

Set `JIG_CODEX_AUTH_DIR` to a directory containing a saved ChatGPT login, even if
Codex is already signed in on the host.

```bash
export JIG_CODEX_AUTH_DIR="$HOME/.codex"
```

The sandbox uses a private copy of `auth.json`. On close, jig writes valid refreshed
credentials back to the selected cache if the source file stayed unchanged. Use a
dedicated login cache for each concurrent job or machine.
