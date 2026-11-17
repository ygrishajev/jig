# Documentation

[Project home](../README.md)

New to jig? Follow the [quickstart](../README.md#quickstart) to initialize a repository,
run a request, and review the resulting branch.

## Get started

- [Installation](installation.md) — requirements, npm installation, and source installation.
- [Authentication](authentication.md) — agent credentials and the Codex login cache.

## Run and configure

- [Commands and lifecycle](commands.md) — start, inspect, resume, and recover runs.
- [Agent presets](presets.md) — select a built-in preset or create your own.
- [Configuration reference](configuration.md) — agent roles, settings, and defaults.

## Operate and understand

- [Architecture map](https://ygrishajev.github.io/jig/architecture.html) — interactive module and flow map ([source](architecture.html)).
- [Sandbox boundaries](sandbox.md) — images, setup, repository access, merging, and signing.
- [Operations](operations.md) — run artifacts, CI outcomes, remote state, logs, and tracing.

## Contribute

- [Contributing](../CONTRIBUTING.md) — local development, validation, code map, and releases.
- [Live end-to-end testing](testing.md) — credentials, assertions, and failure diagnosis.

## Documentation sources

Planned specifications describe future behavior, not current functionality:

- [GitHub Actions issue and PR workflow](specs/github-actions-workflow.md)
- [Run retrospectives and improvement proposals](specs/run-retrospectives.md)

The guides describe the current implementation. When changing behavior, update its
guide in the same change. Keep detailed explanations in the relevant guide and link
to them from the README rather than duplicating them.

- [Configuration schema](../src/config/load-config.ts)
- [Command definitions](../src/cli/commands/)
- [Pipeline transitions](../src/flow/run-flow.ts)
