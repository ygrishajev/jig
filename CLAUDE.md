# jig — house rules

An agentic SDLC orchestrator: a CLI that turns a markdown request into planned slices, has an agent
implement and another review each one inside a sandbox, and lands them on one run branch.
`README.md` has the commands and configuration; `docs/superpowers/specs/` has the design
decisions — read the newest spec before changing anything structural.

## Read before you work

These are the standing rules for this repo. Read the ones that apply to what you are about to
change — they are rules, not suggestions, and they override your defaults.

- [`.claude/instructions/clean-code-over-comments.md`](.claude/instructions/clean-code-over-comments.md)
  — writing or changing any code — naming, structure, and why new code carries almost no comments
- [`.claude/instructions/callee-owns-its-rules.md`](.claude/instructions/callee-owns-its-rules.md)
  — writing or changing any code — a rule lives once, in the module it is about; callers ask for answers, not ingredients
- [`.claude/instructions/errors-as-values.md`](.claude/instructions/errors-as-values.md)
  — writing or changing any code that can fail — an expected failure is an `Err`, a bug is a `panic`, jig never throws
- [`.claude/instructions/parse-input-at-the-edge.md`](.claude/instructions/parse-input-at-the-edge.md)
  — reading anything from outside jig, or adding a CLI argument or option — parse once at the edge, typed values inside
- [`.claude/instructions/testing-conventions.md`](.claude/instructions/testing-conventions.md)
  — writing or changing any spec — ports over module mocks, fakes over stubs, faker-built data, what not to assert
- [`.claude/instructions/setup-function-instead-of-beforeeach-in-unit-service-level-tests.md`](.claude/instructions/setup-function-instead-of-beforeeach-in-unit-service-level-tests.md)
  — writing a spec — `setup` at the bottom of the root `describe`, never `beforeEach`
- [`.claude/instructions/use-mock-instead-of-as-unknown-as-in-tests.md`](.claude/instructions/use-mock-instead-of-as-unknown-as-in-tests.md)
  — building a test double — `mock<T>()`, not `as unknown as T`
- [`.claude/instructions/commit-and-pr-conventions.md`](.claude/instructions/commit-and-pr-conventions.md)
  — committing, naming a branch, opening a PR
- [`.claude/instructions/writing-requests-for-agents.md`](.claude/instructions/writing-requests-for-agents.md)
  — writing a request file, a GitHub issue, or a prompt jig sends — the text is an agent's entire input

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
  environment and go into the container as env vars. Every `.env` is git-ignored; keep it that way.
- **Tags publish.** Pushing a `v*.*.*` tag runs `.github/workflows/publish.yml`, which publishes
  the package to GitHub Packages. Bump the version in a commit first; never push a tag casually.
