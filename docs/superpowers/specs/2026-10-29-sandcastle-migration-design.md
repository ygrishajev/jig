# Sandcastle Migration

Date: 2026-10-29

## Problem

sdlc's sandbox is a hand-rolled `docker run --rm` per agent call
(`docker-cli.ts`, `provider-profiles.ts`, `docker/agent-sandbox/`). It works,
but:

- Every agent call starts cold: dependencies, build caches and agent
  sessions never survive between implement, review and fix calls.
- Only two agents (claude, opencode), each wired by hand.
- Two steps run outside the sandbox: planning bind-mounts the operator's real
  repo root read-write, and `verifyCommand` runs agent-written code on the
  host.
- No timeout on any agent call — a hung agent hangs the run.
- Structured output goes through a file in the agent's cwd
  (`.sdlc-step-output.json`) that has to be reset around every call and has
  leaked into a commit before.

[Sandcastle](https://github.com/mattpocock/sandcastle) (`@ai-hero/sandcastle`,
checked against v0.12.0 @ `a53e227`) provides reusable sandboxes, worktree
management, agent factories for six agents, and idle timeouts.

## Goal

Replace sdlc's sandbox layer with sandcastle, run every agent call and every
validation inside one reusable sandbox per run, and shrink the CLI to the
commands people actually need. sdlc keeps owning the pipeline: run state,
slices, prompts, review loop, the run branch, and the final merge.

## Non-Goals

- No gradual rollout or compatibility layer. sdlc has no users yet: implement,
  test, roll back on failure.
- No published sandbox image. Images are built per machine, per repo.
- No network egress controls (neither the current sandbox nor sandcastle has
  them).
- No use of sandcastle's prompt files, `.sandcastle/.env`, `main.mts`, or its
  `init` command.

## Decisions

### 1. Sandcastle owns the worktree

`createSandbox` (the only reusable-sandbox API) requires a `branch` and always
creates its own worktree at `.sandcastle/worktrees/<branch-with-dashes>`. It
throws if the branch is checked out in a worktree it doesn't manage
(`WorktreeManager.ts:289`), so sdlc can't keep `.sdlc/<id>/workspace`.

- A run calls `createSandbox({ branch: "sdlc/run/<id>", baseBranch, cwd: repoRoot, sandbox: docker(...) })`.
- Resume works natively: sandcastle reuses a managed worktree on the same
  branch (clean → fast-forwarded from origin; dirty → reused with a warning).
- Host-side steps use `sandbox.worktreePath`.
- `commitSigning: "skip"` moves into a `hooks.host.onWorktreeReady` hook.
- sdlc writes `.sandcastle/.gitignore` (`*`) if missing — sandcastle only
  writes it from `init`, and without it `.sandcastle/worktrees/` makes the
  operator's tree dirty, which blocks `mergeBranchInto`.
- Linked-worktree git mounts are handled by sandcastle
  (`resolveGitMounts`, `SandboxFactory.ts:264`).

Removed: `git/worktree.ts`, `ensureWorkspaceOnBranch`, `RunPaths.workspaceDir`.

### 2. One sandbox per run, reused across calls

- Opened at the start of `sdlc run`, closed when the run completes or blocks
  (`await using`).
- Every agent call in the run — planner, implementer, reviewer, describer —
  is a `sandbox.run()` with its own agent; validations use `sandbox.exec()`.
- A crash or resume gets a fresh container. Nothing may depend on in-container
  state across `sdlc run` invocations.
- `setupCommand` (e.g. `npm ci`) runs once per sandbox via
  `hooks.sandbox.onSandboxReady`.

### 3. Our own narrow interface, sandcastle behind an adapter

The orchestrator depends on sdlc's interface, not sandcastle's types:

```ts
interface AgentSession {
  run<T>(input: {
    prompt: string;
    agent: StepConfig;
    schema?: ZodType<T>;
  }): Promise<AgentRunResult<T>>;
  exec(command: string): Promise<ExecResult>;
  close(): Promise<void>;
}
```

- Production: `SandcastleSession` (~40 lines over `createSandbox`).
- Tests: the existing fake, reshaped to return parsed objects instead of
  writing files.
- Rationale: faking sandcastle's `Sandbox`/`SandboxRunResult` couples every
  orchestrator test to a fast-moving third-party type.

Removed: `AgentProvider`, `docker-cli.ts`, `provider-profiles.ts`,
`agentic-cli.ts`.

### 4. Agents: one registry, generated image layer

A single registry replaces `provider-profiles.ts`:

```ts
const AGENTS = {
  claude: {
    npm: '@anthropic-ai/claude-code',
    credentials: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    factory: claudeCode,
  },
  opencode: { npm: 'opencode-ai', credentials: ['OPENROUTER_API_KEY'], factory: opencode },
};
```

Adding codex/pi later is one entry (install line copied from sandcastle's
templates, which aren't exported).

### 5. Credentials

- sdlc collects the credential env vars for every provider used in config
  from `process.env` and passes them to `docker({ env })` at sandbox creation.
- Agent-level `env` appears to be ignored by `createSandbox`
  (`agentProviderEnv: {}`, `createSandbox.ts:779, 968`) — confirm in spike.
- `.sandcastle/.env` is not used; without it, sandcastle's `resolveEnv`
  resolves nothing, so no host env leaks in.
- Fail fast before any container starts if a configured provider has no
  credential.
- opencode uses its provider's env var (e.g. `OPENROUTER_API_KEY`) instead of
  shipping `auth.json`. Removed: `OPENCODE_AUTH_JSON`, `hostEnvFileMounts`,
  `entrypoint.sh`.

### 6. Image: repo-owned toolchain, sdlc-owned agents

Sandcastle publishes no image; it ships per-agent Dockerfile templates built
locally with the host UID baked in. sdlc follows that model:

```
.sandcastle/Dockerfile        committed, repo-owned: base + project toolchain
        │ docker build → <name>-base
        ▼
agent layer                   generated by sdlc, never committed
  FROM <name>-base
  ARG CLAUDE_VERSION OPENCODE_VERSION
  RUN npm i -g @anthropic-ai/claude-code@${CLAUDE_VERSION} opencode-ai@${OPENCODE_VERSION}
  LABEL sdlc.agents=… sdlc.agent-versions=… sdlc.dockerfile-hash=…
  ENTRYPOINT ["sleep", "infinity"]
        │ docker build → <name>
        ▼
image passed to docker({ imageName })
```

- Repo Dockerfile orders the toolchain before the UID args, so expensive
  layers are shared across UIDs.
- UID baked at build time (sandcastle's standard `AGENT_UID`/`AGENT_GID`
  build args); each machine builds its own image.
- Image name defaults to sandcastle's convention (repo dir name);
  `sandboxImage` in config overrides it (and disables building).

**When `sdlc run` builds** — it inspects the image labels first:

| Check                                              | Mismatch →            |
| -------------------------------------------------- | --------------------- |
| `sdlc.dockerfile-hash` vs `.sandcastle/Dockerfile` | rebuild base + agents |
| `sdlc.agents` vs providers in config               | rebuild agent layer   |
| `sdlc.agent-versions` vs target versions           | rebuild agent layer   |

All match → no build.

**Agent versions** are checked every run:

- Target = pinned version from config (`agents: { claude: "x.y.z" }`), else
  npm `latest` (parallel requests, ~2 s timeout).
- `agentUpdates: "auto" | "warn" | "off"` (default `auto`).
- npm unreachable → use what's in the image, log a warning, never block.

**CI**: per-repo layer cache via `docker buildx` with
`--cache-from/--cache-to type=gha`, enabled by flag or env var.

### 7. `sdlc init` sets up the toolchain, verified

`setupCommand` and `verifyCommand` in `sdlc.config.json` define what "proper
toolchain" means: the image is correct when both pass inside it.

1. Write `.sandcastle/Dockerfile` (base, empty toolchain section),
   `.sandcastle/.gitignore`, and a starter `sdlc.config.json`.
2. Planner agent, sandboxed on the base image, inspects the repo (manifests,
   lockfiles, version files, CI workflows) and fills the toolchain section;
   proposes `setupCommand`/`verifyCommand` if unset.
3. Build the image.
4. Run `setupCommand` then `verifyCommand` via `sandbox.exec()`.
5. On failure, feed the error back to the agent and retry from 3 (≤ 3
   attempts); then stop and leave the Dockerfile for manual completion.
6. Operator reviews and commits.

`--no-agent` skips 2 and 5 (template only; the check still runs). The loop is
driven by sdlc on the host — the agent can't run `docker build`.

### 8. Validations run in the sandbox

- `verifyCommand` runs via `sandbox.exec()` after an approved review, in the
  same warm container (dependencies already installed).
- Planning runs in the sandbox worktree, not against the operator's repo
  root.

### 9. Structured output via a tag in stdout

Sandcastle's `Output.object` exists only on one-shot `run()`, not on
`sandbox.run()`, and its extractor isn't exported. sdlc implements the same
protocol (ADR 0010 in sandcastle) in ~25 lines:

- Prompt instructs the agent to end with `<sdlc-output>{json}</sdlc-output>`.
- Take the last tag in `result.stdout` (parsed assistant text for both
  agents — spike #4), strip an optional code fence, `JSON.parse`, validate
  with zod.
- On failure, retry by resuming the same session with the error ("your output
  failed validation: …; re-emit only the corrected tag"), up to N times; then
  fail as today.
- Resume, uniformly for all agents: wrap the agent factory to append
  `--continue` for the retry call only. Calls in one sandbox are sequential,
  so the last session is the failed one. Works for opencode, which sandcastle
  marks non-resumable only because it won't transfer SQLite sessions across
  containers (its ADR 0016) — not needed inside one container.
- Design step returns `{ design, plan }` markdown in its output; sdlc writes
  them to `.sdlc/<id>/state/`. Nothing is written into the worktree.

Removed: `structured-output.ts` file protocol, every
`resetStructuredOutput` call, `assertPlanningDocsWritten`, the relative-path
workaround in `buildDesignPrompt`.

### 10. CLI: four commands

```
sdlc init                         # Dockerfile + config, toolchain verified (§7)
sdlc build [--pull-agents]        # explicit image build (§6)
sdlc run [request.md] [--id <id>] # start or resume
sdlc status <id>                  # read-only
```

`sdlc run` dispatch:

| Request file | `--id` | Run exists | Result                                                 |
| ------------ | ------ | ---------- | ------------------------------------------------------ |
| yes          | —      | —          | new run, generated id                                  |
| yes          | yes    | no         | new run with that id                                   |
| —            | yes    | yes        | resume                                                 |
| —            | yes    | no         | error: no such run                                     |
| yes          | yes    | yes        | resume if file matches stored `rawRequest`, else error |
| —            | —      | —          | error: need a request file or an id                    |

A run that exists but crashed before `context.json` was written re-plans.

`run` ends with: all slices approved → PR description (describer agent) →
merge if `mergeMode: "auto"`.

Removed: `prepare` (use `designGate: "checkpoint"`), `implement`/`review`,
`merge` (auto mode, or `git merge` by hand — `finalizeRun` detects it),
`create-pr` (folded into `run`), `autopilot`/`resume` (now `run`).

### 11. Timeouts

Agent calls use sandcastle's idle timeout (default 600 s), configurable.

### 12. Cleanup

- Dead code: `implementing` status, `mergeAttempts`, `conflictResolveCap`,
  `createBranchFrom`.
- CLI version read from `package.json` (hardcoded `0.1.0`).
- Slice commit messages become configurable, defaulting to a conventional
  commit (`commitMessage: "feat(sdlc): {title}"`, with `{sliceId}` and
  `{title}` placeholders). Today's fixed `sdlc: implement <id> — <title>`
  fails commitlint in target repos — firefly's `validate` workflow and
  commit hook both carry an exception just for it.
- README: configuration and sandbox sections rewritten.
- Removed from the package: `docker/`, `docker:build` script, ghcr
  sandbox-image publish job, `SDLC_AGENT_SANDBOX_IMAGE`.

### 13. Architecture: layers, flow as data, events

**Requirement**: the code reads like a book. Kinds of modules (loop,
executors, errors, state, adapters) are told apart by where they live, each
part is replaceable, and someone — or an agent — reading the flow definition
alone can explain the whole run. A generated diagram is a good test of that
bar, not a deliverable.

Plain TypeScript, ports and adapters. XState and Effect were considered and
rejected: both are frameworks the code would be written inside, which costs
readability for a ~10-state flow. A clean ports-and-adapters core can be
ported to Effect later if ever needed.

Revisited after step 3, when hand-rolled utilities were replaced by
libraries. `@xstate/store` would only replace the reducer and the event
emitter, not the engine. An XState machine would replace all three and give
resume through persisted snapshots, but ties saved runs to the machine's
internal shape (snapshots would need versioning). Kept the own engine: it is
~200 lines, fully specced, and saved runs stay plain JSON. Revisit if the flow
grows parallel slices, timers as states, or deeper nesting.

```
src/
  domain/      pure: Run, Slice, transitions, policies, errors, events   (no I/O)
  flow/        flow definitions (data) + the engine that runs them      (the loop)
  steps/       context, plan, design, slice, implement, review, verify, describe, merge
  prompts/     prompt text only (no output protocol)
  ports/       AgentSession, Workspace, RunStore, Logger, Telemetry, Clock
  adapters/    sandcastle, simple-git, local/git-remote run stores, pino, otel
  observers/   logging, metrics, tracing — event subscribers
  app/         composition root: config → adapters → engine
  cli/         thin: parse args, call app
```

Dependencies point inward only (cli → app → flow/steps → ports/domain).
`domain` imports nothing; only adapters import sandcastle, pino, OTel or
simple-git.

**The whole run is a flow**, defined as data, with the slice loop nested:

```ts
export const runFlow = defineFlow({
  context: { step: buildContext, on: { done: 'planning' } },
  planning: { step: planFeature, on: { done: 'designing' } },
  designing: { step: writeDesign, on: { done: 'slicing' } },
  slicing: { step: sliceThePlan, on: { done: 'gate' } },
  gate: { step: designGate, on: { continue: 'slices', pause: 'paused' } },
  slices: {
    flow: sliceFlow,
    forEach: 'slice',
    on: { allApproved: 'describing', blocked: 'stuck' },
  },
  describing: { step: describePr, on: { done: 'merging' } },
  merging: { step: merge, on: { merged: 'done', manual: 'awaitingMerge' } },
  // terminal: done, paused, stuck, awaitingMerge
});

export const sliceFlow = defineFlow({
  pending: { step: implement, on: { done: 'in_review' } },
  in_review: {
    step: review,
    on: { approved: 'verifying', rejected: 'pending', capReached: 'stuck' },
  },
  verifying: { step: verify, on: { passed: 'approved', failed: 'pending' } },
  // terminal: approved, stuck
});
```

- Steps receive ports and the current state, and **return an outcome**; they
  never mutate state or call each other.
- The engine applies outcomes through a pure `transition()`, saves state,
  emits events, and picks the next step. Resume is uniform: a crash in any
  phase (planning included) resumes at that state.
- `sdlc flow --mermaid` (rendering the definition) is optional, not planned.

**Events** are typed domain events emitted by the engine and steps:
`RunStarted`, `StepStarted`, `StepFinished`, `AgentCallFinished { usage,
cost, durationMs }`, `StateTransitioned`, `StateSaved`, `RunBlocked`,
`RunFinished`. Logging, metrics and tracing are subscribers — no step contains
a log or metrics call.

**Errors** are a typed hierarchy classified by what happens next; the engine's
policy decides, steps don't:

| Class      | Examples                                       | Engine does                        |
| ---------- | ---------------------------------------------- | ---------------------------------- |
| `retry`    | container start failed, npm timeout            | retry the step (bounded)           |
| `feedback` | invalid output, verify failed, review rejected | return to the agent with the error |
| `block`    | review cap reached, merge conflict             | stop; human needed                 |
| `fatal`    | missing config/credentials, bug                | abort with a clear message         |

**Libraries over hand-rolled code.** Where a commonly used library does the
job, use it: awilix for dependency injection (one container in `src/app/`,
a scope per run; adapters stay plain classes wired by factory functions),
Node's `EventEmitter` for publishing events, p-retry for step retries,
write-file-atomic for state saves, pino for logging, zod for validation.

**Replaceability**: every port is swappable in the composition root
(code-level). The run store and observers are also user-pluggable from config
(`"use": "./module.js"`), making those two interfaces public API.

### 14. RunStore (state and checkpointing are one port)

```ts
interface RunStore {
  load(runId: string): Promise<RunSnapshot | undefined>;
  save(snapshot: { runId; state: RunState; branchHead: string; reason: string }): Promise<void>;
}
```

- State and branch head are saved together, so a resume never sees state
  ahead of or behind the code.
- The engine saves after every transition.
- Implementations:
  - `local` (default) — `.sdlc/<id>/state`.
  - `git-remote` — pushes the run branch, plus state on a hidden ref
    (`refs/sdlc/<id>`) so the user's branch list stays clean. Enables
    resuming on another machine, e.g. a retried CI job on a fresh runner.
  - `custom` — a module from config implementing `RunStore`.
  - `composite` — e.g. `[local, git-remote]`: save to all; load from the
    first that has it.

Replaces `state/store.ts`'s direct file I/O at call sites.

### 15. Logging

- pino as the core; format chosen by transport:
  - TTY → human-readable (pino-pretty or a compact custom formatter).
  - CI or `--log-format json` → JSON lines on stdout.
  - Always → JSON log file at `.sdlc/<id>/state/run.log`.
- Agent output is structured using sandcastle's parsed stream events
  (`text`, `tool_call`, `usage`, `session_id`), e.g.
  `tool_call: Bash "npm test"` as fields, not raw lines. A verbosity flag
  controls whether agent text is shown.
- Replaces `logRun`/`console.log` and the raw stdout piping in
  `docker-cli.ts`.

### 16. Telemetry (OpenTelemetry, optional)

- A tracing observer maps events to spans: run → phase/slice → step → agent
  call, with GenAI semantic-convention attributes
  (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, …).
- Loaded only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; the core never
  imports `@opentelemetry/*`.
- When enabled, `OTEL_*` env is forwarded into the sandbox so Claude Code's
  own telemetry can nest under sdlc's spans (verify in spike).

### 17. Metrics

| Metric                                              | Source                                                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens (input, output, cache read/write, reasoning) | raw-line tap on `parseStreamLine`: claude `result.usage`, opencode `step_finish.tokens` (spike #7)                                                          |
| Cost                                                | agent-reported via the same tap: claude `total_cost_usd`, opencode `step_finish.cost`; a price table with config overrides only for agents that report none |
| Rounds                                              | review cycles per slice, output-validation retries, `init` attempts, engine passes                                                                          |
| Durations                                           | per phase, step, agent call; image build; setup; verify                                                                                                     |
| Outputs                                             | diff size per slice (files, lines), verify pass/fail, first-pass approval, rejection reasons                                                                |

Stored as `metrics.jsonl` (one record per agent call/step) plus a summary in
`result.json` and a one-line PR description footer (e.g. "3 slices · 2 review
rounds · 412k tokens · $1.84 · 18 min"). Exported via OTel when enabled.

## Config (after)

```json
{
  "mergeMode": "manual",
  "reviewCycleCap": 3,
  "designGate": "auto",
  "commitSigning": "repo",
  "setupCommand": "npm ci",
  "verifyCommand": "npm run lint && npm test",
  "sandboxImage": null,
  "agentUpdates": "auto",
  "agents": { "claude": null, "opencode": null },
  "runStore": ["local"],
  "observers": [],
  "pricing": {},
  "planner": { "provider": "claude" },
  "implementer": { "provider": "claude" },
  "reviewer": { "provider": "claude" },
  "describer": { "provider": "claude" }
}
```

## Spike — verify before committing to the design

1. A linked worktree created by `createSandbox` works for git inside the
   container (commit, log, rebase onto moved base).
2. Credentials passed through `docker({ env })` reach both agents; agent-level
   `env` is ignored under `createSandbox`.
3. opencode authenticates from its provider env var alone (no `auth.json`).
4. `result.stdout` content per agent: assistant text (claude) vs raw JSON
   events (opencode `--format json`) — decides tag extraction.
5. `--continue` on a non-interactive `run` resumes the just-failed session,
   for both claude and opencode.
6. Agent CLIs installed via npm at a pinned version in the generated layer run
   as the baked UID with a writable `$HOME`.
7. Token usage and cost are obtainable for opencode.
8. Forwarded `OTEL_*` env makes Claude Code emit spans under sdlc's trace.

### Spike findings

Run 2026-10-29, sandcastle 0.12.0, Docker 29.4, macOS, `spike/check-sandbox.ts`
(no agent calls):

- **#1 passes** — status, log, commit and `git rebase main` onto a base moved
  on the host all work inside the managed worktree; commits are on the host
  branch after `close()`; the clean worktree is removed on close; the
  operator's tree stays clean with `.sandcastle/.gitignore` written up front.
- **Symlinked repo paths break git.** With the repo under macOS `/var` (a
  symlink to `/private/var`), git records the worktree's real path in the
  `gitdir:` pointer while sandcastle mounts `.git` at the path it was given:
  every git command fails with "not a git repository". Fix in sdlc:
  `realpath(repoRoot)` before `createSandbox`. Worth reporting upstream.
  Not macOS-specific: reproduced on Linux by opening the repo through a
  symlink, and fixed there by the same `realpath`.
- **Linux (GitHub Actions `ubuntu-latest`, UID 1001,
  [run 40900851055](https://github.com/ygrishajev/sdlc/actions/runs/40900851055))** —
  15/15, same as macOS: direct path passes all checks, symlinked path
  reproduces the git failure, resolved symlink passes.
- **#2 confirmed** — `docker({ env })` reaches the container; agent-level
  `env` (`claudeCode(model, { env })`) is ignored under `createSandbox` for
  both agents. Credentials must go through `docker({ env })`.
- **#6 passes** — runs as the host UID (501:20), `$HOME=/home/agent` is
  writable, npm-installed `claude` (2.1.312) and `opencode` (1.19.5) run.

Agent calls (`spike/check-agents.ts`, `spike/check-usage.ts`; claude via
`CLAUDE_CODE_OAUTH_TOKEN` with `haiku`, opencode via `OPENROUTER_API_KEY` with
`openrouter/~z-ai/glm-flash-latest`):

- **#3 passes** — opencode authenticates from `OPENROUTER_API_KEY` alone; no
  `auth.json`.
- **#4 resolved** — `result.stdout` is the parsed assistant text for both
  agents, not raw JSON events. A plain-text search for the last
  `<sdlc-output>` tag works for both.
- **#5 passes** — wrapping the factory to append `--continue` resumes the
  previous session for both agents (verified with a random number a fresh
  session could not guess).
- **#7 passes, via a raw-line tap** — sandcastle drops cost: `stdout` and its
  log file hold only text, and `iterations[].usage` is tokens only, claude
  only. Wrapping `parseStreamLine` sees every raw line:
  - claude: the `result` event has `total_cost_usd` and full `usage`
    (incl. cache read/write, thinking tokens).
  - opencode: the `step_finish` event has `cost` and `tokens`
    (input, output, reasoning, cache read/write).

  Both agents report cost themselves, so no price table is needed for
  these two.

- **#8 not run** — OTel nesting deferred with the OTel adapter.

Two thin agent wrappers come out of this, both owned by the sandcastle
adapter: `withArgs(agent, '--continue')` for retries and
`withRawTap(agent, onLine)` for usage/cost.

## Order of work

1. ✅ Spike sandcastle; checks on macOS and Linux (see Spike findings).
2. ✅ Flow engine, domain, ports and outcome-returning steps, beside the old
   orchestrator.
3. ✅ Local `RunStore`, pino logging observer, awilix composition root, and
   the CLI switched to `run` / `status` (moved forward from step 8 so the
   old orchestrator could be deleted). Agents still run through the old
   Docker provider, wrapped as an `AgentSession` adapter.
4. Replace the Docker adapter with a sandcastle `AgentSession`; remove the
   old sandbox and image.
5. Structured output via tag + resume retries.
6. Verify and planning inside the sandbox; `setupCommand`; timeouts.
7. Image build: generated agent layer, label checks, version checks, gha
   cache; `sdlc init` and `sdlc build`.
8. Metrics observer; `git-remote` and custom run stores; OTel adapter.
9. Cleanup and README; update firefly's workflow (it calls the removed
   `autopilot` and `create-pr`).

## Deferred

- **Formal model of crash/resume** (Quint, ~1 day): engine loop, step side
  effects, `RunStore` local + remote saves, crashes at any point, two runners
  on one run. Invariants: state matches branch head after every save; one
  commit per approved slice; counters survive crashes; at most one runner
  advances a run. Follow-up: fast-check crash-injection tests asserting the
  same invariants against the real engine.
