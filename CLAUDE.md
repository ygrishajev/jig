# jig — house rules

An agentic SDLC orchestrator: a CLI that turns a markdown request into planned slices, has an agent
implement and another review each one inside a sandbox, and lands them on one run branch.
[`README.md`](README.md) and [`docs/README.md`](docs/README.md) are the public entry points;
[`CONTRIBUTING.md`](CONTRIBUTING.md) is the developer index. Review the
[architecture map](docs/architecture.html) and current implementation before changing anything
structural.

## House rules

The standing rules live in `.claude/rules/`. Claude Code loads them on its own when you touch the
files they cover; any other agent must open the ones that cover the files it will change before
editing, specs included. They are rules, not suggestions, and they override your defaults:

- `clean-code-over-comments.md` — naming, structure, and why new code carries almost no comments
- `callee-owns-its-rules.md` — a rule lives once, in the module it is about; callers ask for answers, not ingredients
- `errors-as-values.md` — an expected failure is an `Err`, a bug is a `panic`, jig never throws
- `parse-input-at-the-edge.md` — parse outside input once at the edge, typed values inside
- `testing-conventions.md` — specs: `setup` not `beforeEach`, ports over module mocks, `mock<T>()`, fakes over stubs, faker-built data, what not to assert

Two procedures are skills: `commit-pr` (committing, naming a branch, opening a PR) and
`write-request` (a request file, a GitHub issue, or a prompt jig sends — the text is an agent's
entire input).

## Keep public references accurate

The public guides describe how to use jig today: commands, arguments, flags, supported configuration
and environment variables, defaults, prerequisites, outputs, and recovery behavior. When a change
affects that interface, inspect every affected existing reference, including guides outside the
edited files, and update it in the same slice. Internal-only work needs no public documentation edit.

Write the supported behavior in the present tense. Replace obsolete instructions and values in
place, and check related links and examples. Keep implementation history and rationale in PR
descriptions or release notes. Preserve the short architecture description and
`docs/architecture.html`; update them when an architectural change makes them inaccurate. Do not
add a guide or changelog entry just to describe a change.

## Use the library, don't rebuild it

Before writing a utility, check whether a commonly used package already does it — retries,
events, atomic writes, DI, logging, validation, parsing. Use it, and keep any wrapper thin
enough that the library's own docs still explain the behaviour. A hand-rolled version needs a
reason in the PR (the library does not fit, or costs more than the code it replaces).
Current picks: awilix (DI, `src/app/` only), Node `EventEmitter`, better-result (errors, retries),
write-file-atomic, pino, zod, simple-git, execa, commander.

## Things that catch people out

- **Agents run unattended only inside the sandbox.** Every agent call skips
  permission prompts, for claude, opencode and codex alike. Never wire an agent call that
  runs on the host, and never add a code path that does so "just for local dev".
- **jig runs against other people's repos.** Its scratch in a target repo (`.jig/`, and
  `.sandcastle/` worktrees, logs and `.env`) must ignore itself, and nothing may touch the target's
  tracked files outside the run's worktree — a dirty operator tree blocks the final merge. The one
  exception is `jig init`, which writes `.sandcastle/Dockerfile` and `jig.config.json` for the
  operator to review and commit.
- **Credentials never land in a file jig writes, a log line, or the image.** They come from the
  environment or `.jig/.env` and go into the container as env vars. The one exception: when the
  operator agrees at `jig init`'s prompt, jig saves a credential to `.jig/.env`, owner-only and
  ignored by `.jig/.gitignore`. Only credentials are read from that file. Codex uses a private copy of an explicitly selected
  login cache; valid refreshed credentials are written back when the sandbox closes. See
  [Codex authentication](docs/authentication.md#codex-authentication). Every `.env` is git-ignored;
  keep it that way.
- **Main publishes.** Each push to `main` runs `.github/workflows/publish.yml`, which validates,
  calculates the next version from conventional commits, and publishes the package publicly to npm
  with provenance via trusted publishing. Semantic-release owns release tags and GitHub Releases;
  the checked-in package version is a development placeholder. Do not create release tags manually.
