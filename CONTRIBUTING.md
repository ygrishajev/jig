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

| Directory       | Responsibility                                                    |
| --------------- | ----------------------------------------------------------------- |
| `src/cli/`      | Commands and input parsing.                                       |
| `src/app/`      | Application lifecycle, workflow assembly, and wiring.             |
| `src/config/`   | Configuration schemas, defaults, presets, and policy.             |
| `src/domain/`   | State, validation, and domain decisions.                          |
| `src/flow/`     | Generic flow contracts and execution.                             |
| `src/steps/`    | Individual pipeline steps.                                        |
| `src/ports/`    | Interfaces for external operations.                               |
| `src/adapters/` | Git, containers, storage, config files, terminals, and telemetry. |
| `src/prompts/`  | Inputs sent to agents.                                            |

Config owns policy and defaults, including the step retry count and delay that resolve into
`RunSettings`; domain owns `RunSettings` and the rules and stopping caps that read it. Settings
cross the `ConfigSource` contract in `src/config/config-source.ts`: config decides absence, schema,
defaults and update merging, and `src/adapters/filesystem/config-source.ts` resolves the file and
moves its raw JSON. Adapters also read preset files, and the CLI captures the process environment, working
directory and home directory before config parses them. `npm run lint:dependencies` rejects config
imports of adapters and filesystem or OS modules.

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
