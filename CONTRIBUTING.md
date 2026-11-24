# Contributing

[Project home](README.md) · [Documentation](docs/README.md)

Read [the house rules](AGENTS.md) and the applicable files in [.claude/rules/](.claude/rules/)
before making changes. Specs sit beside the code they cover; the unit suite uses fake
agents and real temporary git repositories.

## Setup

```bash
git clone https://github.com/ygrishajev/jig.git
cd jig
npm ci
npm run build
npx husky
```

The repository `.npmrc` disables install scripts, so enable hooks explicitly with `npx husky`.
Use `npm run dev -- <command>` during development, or `npm run install:local` to install
a built package globally.

## Validation

Use the development Node version pinned in `package.json` through Volta.

Run routine validations concurrently, with each check's stdout and stderr printed together
when it finishes. Failed checks do not cancel the others; any failure makes the command fail.
The default includes build, typecheck, lint, duplication, formatting, coverage (which runs
the test suite), and secret scanning. Mutation testing is omitted and reported as such;
run `npm run test:mutation` separately when needed. The legacy `--skip test:mutation`
option remains accepted, but is unnecessary. Explicit check names can opt into mutation testing.

```bash
npm run validate
npm run validate -- lint typecheck
npm run validate -- --skip test:coverage
npm run validate -- --help
```

```bash
npm test              # fast suite
npm run lint
npm run lint:duplication # jscpd, production source only
npm run test:coverage    # Vitest V8, text + HTML + LCOV
npm run format:check
npm run test:mutation # StrykerJS, slow (~30 min)
npm run secretlint
```

Lint checks production functions for cyclomatic complexity above 10 (errors) and
cognitive complexity above 15 (errors), using ESLint and SonarJS respectively.
Duplication checks fail when jscpd finds duplicated production code with its default clone
size settings; specs are excluded. Reports go to `reports/duplication/`, and coverage reports
go to `coverage/`. Stryker remains the mutation-testing tool.

`vitest.workspace.ts` defines the named `unit` and `e2e` projects. The root config
loads `vitest.unit.workspace.ts` by default, including for mutation testing.
`npm test`, coverage, and watch also select `unit` explicitly. The E2E script selects
the full workspace with `--workspace vitest.workspace.ts --project e2e`.

## Live E2E

The [live end-to-end guide](docs/testing.md) covers credentials, role assignment,
assertions, and failure diagnosis. This opt-in check requires Docker and makes real
agent calls; it is excluded from `npm test` and `npm run validate`.

## Code map

Explore the [interactive architecture map](docs/architecture.html) for module relationships
and run flows. Download and open it in a browser; GitHub displays HTML as source.

| Directory          | Responsibility                                                      |
| ------------------ | ------------------------------------------------------------------- |
| `src/composition/` | The `jig` executable: composes the CLI and starts it.               |
| `src/cli/`         | Commands and input parsing.                                         |
| `src/app/`         | Public operations, lifecycle, workflow assembly, and the container. |
| `src/config/`      | Configuration schemas, defaults, presets, and policy.               |
| `src/domain/`      | State, validation, domain decisions, and business failures.         |
| `src/failures/`    | Failure messages, panic unwrapping, and retry of `Result`s.         |
| `src/flow/`        | Generic flow contracts, execution, and the step retry policy.       |
| `src/steps/`       | Individual pipeline steps.                                          |
| `src/ports/`       | Interfaces for external operations and their failures.              |
| `src/adapters/`    | Git, containers, storage, config files, terminals, and telemetry.   |
| `src/prompts/`     | Inputs sent to agents.                                              |

Config owns policy and defaults, including the step retry count and delay that resolve into
`RunSettings`; domain owns `RunSettings` and the rules and stopping caps that read it. Settings
cross the `ConfigSource` contract in `src/config/config-source.ts`: config decides absence, schema,
defaults and update merging, and `src/adapters/filesystem/config-source.ts` resolves the file and
moves its raw JSON. Presets cross the `PresetSource` contract in `src/config/preset-source.ts`:
`src/adapters/filesystem/preset-source.ts` orders the preset directories and yields candidates
lazily, while config skips invalid names, lets the first candidate of a name win, validates it and
merges whole roles. The process environment, working directory and home directory are captured at
the process edge before config parses them, by composition for every command.
`npm run lint:dependencies` allows production config to import only
`src/config`, `src/domain`, `better-result` and `zod`; config specs and their test packages are
exempt. It also keeps `src/failures/` a leaf: it imports only itself, `better-result` and Node
built-ins, and domain, ports, config and prompts cannot import it.

`src/composition/main.ts` is the executable. `buildJigCli()` adds the GitHub commands to the core
CLI, bound to the same operations, and the module parses arguments only when it is the invoked
script, so importing it starts nothing. `npm run lint:dependencies` lets no production owner but
composition import `src/cli/`. Production composition may import only composition, cli, app,
adapters, config, observers, ports, domain and failures, and no other production owner may import
composition. Adapters cannot import app, flow, steps, cli or composition.
A file under any directory not listed in the code map fails as unowned. Specs and tooling outside `src/` may import CLI helpers.
Only cli and composition import `src/app/`. Everywhere outside app and composition, specs
included, app is reached only through `src/app/api.ts`; the public entry imports no adapter or
observer, and production app has no type-only import of either, so an app contract names a port
or an app type instead. Tooling and helpers outside `src/` may import any app module.

`src/app/api.ts` is the application's public entry. `jig status` and `jig presets` call its
operations: `readRunStatus` and `listPresets` take the context composition captured and narrow
capabilities composition supplies, and `prepareRepository` in `src/app/repository-preparation.ts`
decides the order: repository root, environment, saved credentials, config, preset directories. The
handlers in `src/cli/commands/status.ts` and `src/cli/commands/presets.ts` receive the bound
operations as `JigOperations` and only parse input and format the result. Status reports its metrics
and documents through the `RunRecords` contract in `src/ports/run-records.ts`, implemented by
`src/adapters/local-store/local-run-records.ts`.

`jig run` calls `startOrResumeRun` from the same entry. The handler in `src/cli/commands/run.ts`
parses its input and reads the request file or standard input through the `RequestInputs` it is
given, so unusable input calls no operation. The operation prepares the repository, applies the
preset (asking through a supplied chooser; nobody picking refuses the run) and only then asks the
supplied `openRuntime` for the run's capabilities. `runJig` in `src/app/run-jig.ts` owns the run
policy over `RunCapabilities`: the lock, which stores to open (`openRunStore` in
`src/app/run-stores.ts` adds required stores to the configured ones), start or resume by id, the
ended-run report, credentials and image before any sandbox, and the invocation's records.
`withResource`, `releaseInOrder` and `releasingOnPanic` in `src/app/lifecycle.ts` acquire, use
and release: every release is attempted, a partial acquisition releases what it already holds even
when it panics, the first panic propagates as thrown while a cleanup that fails or panics after it
is logged, and the cleanup rule of `reportCleanup` applies. A run
releases its sandbox session, then its scope, then telemetry, then the lock. Stores are built by
`src/adapters/run-store/repository-run-stores.ts` behind `RunStoreCatalog` in
`src/ports/run-store.ts`, which also loads and checks a custom store module. Composition binds the
run's runtime to `openRunRuntime` in `src/app/container.ts`, which still builds it with Awilix until
spike #49 records the construction mechanism.

`jig init` and `jig build` call `initRepository` and `buildSandboxImage` from the same entry; the
handler in `src/cli/commands/sandbox.ts` only parses input and prints the summary or image name.
Both prepare the repository first (`build` then applies the preset; cancelling the pick builds
nothing) and only then ask the supplied `openSandboxRuntime` for a `SandboxRuntime`, released
however the operation ends. Init decides when to ask for agents, for a missing credential and
whether to save it, through the `InitInteraction` composition supplies from
`src/adapters/terminal/`; the starter files sit behind `StarterFiles` in
`src/ports/starter-files.ts`, and agent credentials and the owner-only `.jig/.env` behind
`AgentCredentials`. Agents run only on a session `withThrowawaySandbox` opens on its own branch,
closes and removes. Composition binds `openSandboxRuntime` in `src/app/container.ts`, which still
builds it with Awilix until #49.

`jig github implement` calls `implementGithubIssue` from the same entry. The handler in
`src/cli/commands/github.ts` only parses the issue number and options and describes the outcome.
The operation in `src/app/implement-issue.ts` reads the GitHub settings first, through
`src/config/github-settings.ts`, which validates the token and repository and decides their
precedence, so a missing token is refused before the origin is read and every settings refusal
comes before the repository is prepared or anything is built. It then gets its run through
`withPreparedRun` in `src/app/run-operation.ts`, the same preparation, preset selection, runtime
and release `jig run` uses, accepts the issue, runs it through `runJig` with the remote store
required and its code held back, and publishes the outcome, using the request snapshot, findings
and publication content in `src/app/`. It receives its capabilities: the GitHub API for a token in
`src/ports/github.ts` (implemented by
`src/adapters/github/octokit-github.ts`) and the guarded run branches in `src/ports/run-branches.ts`
(implemented by `src/adapters/git/run-branches.ts`, which enforces the protected-path refusal from
`src/domain/protected-paths.ts`). `src/adapters/git/github-origin.ts` reads the repository name
from the origin. Composition supplies each of these lazily, so help needs no token or repository.

GitHub publication keeps its shared receipts and leases in `refs/jig/_orchestration`. Domain owns
their state, schema and transitions (`src/domain/orchestration.ts`) and the repository identity
(`src/domain/repository-identity.ts`); `src/ports/publication-receipts.ts` declares the receipt-store
and publication-ownership capabilities and their failures; `src/adapters/git/orchestration-ref.ts`
persists them in the hidden ref; and `withPublicationOwnership` in `src/app/publication-ownership.ts`
owns the publication lifetime: it claims the lease, renews it before each outward effect and releases
it however the work ends.

Each failure class lives with the owner of what it means: business failures in
`src/domain/errors.ts`, capability failures in the port that declares them (GitHub in `src/ports/github.ts`, run-branch
publication in `src/ports/run-branches.ts`, publication receipts in
`src/ports/publication-receipts.ts`; shared Git, run-state and local-state failures in `src/ports/git-failures.ts`, `src/ports/run-state-failures.ts` and
`src/ports/local-state.ts`), configuration validation in `src/config/errors.ts`, and use-case and
command input failures in `src/app/` and `src/cli/`. Import a class from its owner; there is no
union of every class. `src/adapters/logging/error-serializer.ts` logs a class split out of
`ConfigInvalid` under that old identity, so run logs stay comparable.

Use the current guides and code for supported behavior. Changes to agent prompts and request files
follow the [write-request procedure](.claude/skills/write-request/SKILL.md). For branches,
commits, and pull requests, follow [commit-pr](.claude/skills/commit-pr/SKILL.md).

## Releases

The [publish workflow](.github/workflows/publish.yml) validates each push to `main`, then
semantic-release calculates the next version from conventional commits since the last release.
Breaking changes release a major version, features release a minor version, and other conventional
commits release a patch version. The workflow publishes to npmjs.org with provenance and creates
the release tag and GitHub Release. The checked-in package version is a development placeholder;
do not bump it or create release tags manually.
