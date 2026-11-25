# Live end-to-end testing

[Documentation](README.md) · [Project home](../README.md) · [Contributing](../CONTRIBUTING.md)

`npm run test:e2e` builds the CLI, then runs `tests/e2e/feature.spec.ts` through a
named `e2e` Vitest project for one real pipeline in a fresh temporary
repository. It uses credentials from the environment, with optional defaults from
the ignored `tests/e2e/.env`. It is opt-in and is not part of `npm test`, `npm run test:integration` or `validate`.
Docker must be running; the check builds an image and makes paid/subscription agent calls.
The script loads that file with `--env-file-if-exists`, which needs Node 22.9 or newer.

Copy `tests/e2e/.env.example` to `tests/e2e/.env` and fill in the desired credentials
and models before running the check.

## Agent credentials

Available agents are assigned in order across planner, implementer, reviewer, and describer:
Claude, OpenCode via OpenRouter, then Codex. With all three available, Claude plans and
describes, OpenCode implements, and Codex reviews. With fewer available, roles reuse them.

- Claude: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`; model defaults to `haiku`,
  overridable with `JIG_E2E_CLAUDE_MODEL`.
- OpenRouter: `OPENROUTER_API_KEY` and `JIG_E2E_OPENROUTER_MODEL=openrouter/<model>`
  (falls back to `OPENCODE_MODEL`).
- Codex: set `JIG_E2E_CODEX_MODEL` (the sample uses `gpt-6-luna`). Prefer an explicit
  `JIG_CODEX_AUTH_DIR` containing a dedicated `auth.json`. Otherwise, the E2E discovers
  `$CODEX_HOME/auth.json`, defaulting to `~/.codex/auth.json`. This intentionally depends
  on an existing machine login. A discovered full login enables Codex automatically.
  The full ChatGPT token bundle is required, including ID, access, refresh, and account
  fields; extracting `tokens.access_token` into `CODEX_ACCESS_TOKEN` does not work here.
  A missing file or a non-subscription login leaves Codex unavailable; malformed files
  fail setup without printing their contents. Keychain-only logins are not supported.

See [Codex authentication](authentication.md#codex-authentication) for the production
login lifecycle and concurrency constraints.

## Assertions and failure diagnosis

The check first proves the supplied six tests fail, then requires a completed run,
one approved slice, planning/description artifacts, every pipeline outcome, a merged
branch, and a clean repository. Only `summary.mjs` may change. The original tests must
remain byte-for-byte identical and pass independently inside a fresh read-only,
network-disabled container after the merge. Agent wording, timings, and token counts
are not fixed. Each CLI invocation has a 15-minute timeout; Vitest limits the full test
to 32 minutes, with no automatic retries. Cleanup cancels pending commands. Failed repositories are
retained at the printed temporary path; successful ones are removed.
