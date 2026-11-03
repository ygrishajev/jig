# Human-Readable Planning Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Planning produces human-readable `design.md` + `plan.md` in run state; slices reference plan steps; the docs surface in `status`, `create-pr`, and run-exit output.

**Architecture:** A new `design` step in `prepareRun` runs between feature-plan and slice-plan; the agent writes the two markdown files directly into the state dir and acks via the structured-output file. The slice-plan prompt then embeds `plan.md` verbatim. A `designGate` config value turns the gap between planning and implementation into a stop point in the `autopilot` command.

**Tech Stack:** TypeScript, Node ≥20, vitest, zod, commander, simple-git.

**Spec:** `docs/superpowers/specs/2026-09-26-planning-artifacts-design.md`

## Global Constraints

- Planning docs are NEVER committed to the target repo — they live only in `<stateDir>` (`.jig/<runId>/state/`).
- `designGate` default is `'auto'`; valid values `'auto' | 'checkpoint'`.
- All planning docs are read via `node:fs/promises` + `existsSync` from `node:fs` — no new dependencies.
- Follow existing code style: no comments unless explaining a non-obvious invariant; prettier + eslint clean; every task is TDD (failing test first).
- Commit messages: sentence-case imperative, `git -c commit.gpgsign=false commit`.

---

### Task 1: Design step in prepareRun + slice-plan prompt consumes plan.md

**Files:**

- Modify: `src/orchestrator/prompts.ts`
- Modify: `src/orchestrator/prepare.ts`
- Test: `tests/orchestrator/prepare.test.ts`

**Interfaces:**

- Consumes: existing `provider.run({cwd, prompt})`, `structuredOutputPath`, `resetStructuredOutput`, `readStructuredOutput`, `logRun(runId, message)`, `paths.stateDir`.
- Produces: `buildDesignPrompt(rawRequest: string, repoSummary: string, planSummary: string, planApproach: string, designPath: string, planPath: string): string` in prompts.ts (exported, like its siblings); `prepareRun` now requires the provider to write `design.md`/`plan.md` into `paths.stateDir`; `buildSlicePlanPrompt(planMarkdown: string): string` — signature CHANGES from `(planSummary, planApproach)` to a single plan.md string.

- [ ] **Step 1: Write the failing tests**

Add to the top imports of `tests/orchestrator/prepare.test.ts`: `existsSync` is already imported; add `readFile` to the `node:fs/promises` import. Then add this test inside `describe('prepareRun')`:

```ts
it('runs a design step that writes design.md and plan.md into the state dir, then slices from plan.md', async () => {
  repo = await createTempRepo();
  const requestPath = path.join(repo.dir, 'request.md');
  await writeFile(requestPath, '# Add a health check endpoint');

  let call = 0;
  let slicePrompt = '';
  const provider = new FakeAgentProvider(async (input) => {
    call += 1;
    if (call === 1) {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ classification: 'feature', repoSummary: 'An Express app.' }),
      );
    } else if (call === 2) {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({
          summary: 'Add /health endpoint',
          approach: 'Add a route returning 200 OK',
          affectedAreas: ['src/routes'],
        }),
      );
    } else if (call === 3) {
      const stateDir = path.join(repo.dir, '.jig', await currentRunId(repo.dir), 'state');
      await writeFile(
        path.join(stateDir, 'design.md'),
        '# Design\n\n## Chosen approach\n\nA route returning 200 OK.',
      );
      await writeFile(path.join(stateDir, 'plan.md'), '# Plan\n\n## Step 1 — Add health route\n');
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ written: ['design.md', 'plan.md'] }),
      );
    } else {
      slicePrompt = input.prompt;
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify([
          {
            id: 'add-health-route',
            title: 'Add health route',
            description: 'Implements plan step 1. Add GET /health',
          },
        ]),
      );
    }
    return { success: true, output: 'done' };
  });

  const meta = await prepareRun({
    repoRoot: repo.dir,
    inputSource: new MarkdownFileInputSource(requestPath),
    provider,
  });

  const stateDir = path.join(repo.dir, '.jig', meta.runId, 'state');
  expect(existsSync(path.join(stateDir, 'design.md'))).toBe(true);
  expect(existsSync(path.join(stateDir, 'plan.md'))).toBe(true);
  expect(slicePrompt).toContain('## Step 1 — Add health route');
  const slices = await readSlices(await loadRunState(repo.dir, meta.runId));
  expect(slices[0].description).toContain('Implements plan step 1');
});
```

The helper `currentRunId` reads the single run dir (createTempRepo starts clean, so the first dir under `.jig/` is this run). Add it at the bottom of the file:

```ts
import { readdir } from 'node:fs/promises';

async function currentRunId(repoDir: string): Promise<string> {
  const entries = await readdir(path.join(repoDir, '.jig'));
  return entries[0];
}
```

Also update the FIVE existing tests with provider fakes (`runs context, plan, and slice-plan steps and persists the result`, `runs the planning steps with the real repository as cwd, not an empty scratch directory`, `leaves no structured-output file behind in the repo root once done`, `throws a clear error when the slice-plan step returns zero slices`, `throws a clear error naming the duplicate id…`, `throws when the slice-plan step returns an id with characters unsafe…`): every provider fake in this file must gain the extra design-step call — renumber `call === 2` (feature plan) / `call === 3` (design: write design.md + plan.md into `path.join(repo.dir, '.jig', currentRunId(repo.dir), 'state')` + ack JSON) / `call === 4` (slices). For the cwd test, the expected array becomes `[repo.dir, repo.dir, repo.dir, repo.dir]`.

Add a failure test:

```ts
it('throws a clear error when the design step does not write plan.md', async () => {
  repo = await createTempRepo();
  const requestPath = path.join(repo.dir, 'request.md');
  await writeFile(requestPath, '# Add a health check endpoint');

  let call = 0;
  const provider = new FakeAgentProvider(async (input) => {
    call += 1;
    const output =
      call === 1
        ? { classification: 'feature', repoSummary: 'An Express app.' }
        : call === 2
          ? { summary: 'Add /health endpoint', approach: 'Add a route', affectedAreas: ['src'] }
          : call === 3
            ? { written: [] }
            : [
                {
                  id: 'add-health-route',
                  title: 'Add health route',
                  description: 'Implements plan step 1. Add GET /health',
                },
              ];
    await writeFile(structuredOutputPath(input.cwd), JSON.stringify(output));
    return { success: true, output: 'done' };
  });

  await expect(
    prepareRun({
      repoRoot: repo.dir,
      inputSource: new MarkdownFileInputSource(requestPath),
      provider,
    }),
  ).rejects.toThrow(/design step did not produce.*plan\.md/is);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/prepare.test.ts`
Expected: FAIL — provider fake's design-step call is never made (prepareRun still has 3 provider calls), so call 3 gets the slices prompt and returns slices JSON as ack → parse error / missing files assertion fails.

- [ ] **Step 3: Add the design prompt to prompts.ts**

Add below `buildFeaturePlanPrompt`:

```ts
export function buildDesignPrompt(
  rawRequest: string,
  repoSummary: string,
  planSummary: string,
  planApproach: string,
  designPath: string,
  planPath: string,
): string {
  return [
    'You are the design step of an automated SDLC pipeline.',
    'You run unattended: when you would present options to a human, evaluate 2-3 approaches,',
    'pick the recommended one, and record the alternatives with rejection rationale.',
    '',
    '--- REQUEST ---',
    rawRequest,
    '',
    '--- REPOSITORY CONTEXT ---',
    repoSummary,
    '',
    '--- PLAN SUMMARY ---',
    planSummary,
    '',
    '--- APPROACH ---',
    planApproach,
    '',
    `Write TWO markdown files:`,
    `1. "${designPath}" with sections: Goal; Context; Chosen approach; Alternatives considered`,
    `   (each with why it was rejected); Assumptions; Non-goals; Affected areas.`,
    `2. "${planPath}" — the overall implementation plan as numbered steps, each under a`,
    `   \`## Step N — <title>\` heading, each step small enough to map onto one slice.`,
    '',
    `Respond with JSON matching: { "written": string[] } listing the file names you wrote.`,
    structuredOutputInstruction(),
  ].join('\n');
}
```

- [ ] **Step 4: Change buildSlicePlanPrompt and rewire prepareRun**

In prompts.ts, change `buildSlicePlanPrompt` to:

```ts
export function buildSlicePlanPrompt(planMarkdown: string): string {
  return [
    'You are the PR-slicing step of an automated SDLC pipeline.',
    '',
    '--- IMPLEMENTATION PLAN ---',
    planMarkdown,
    '',
    'Break this plan into an ordered sequence of small, independently reviewable slices.',
    "Each slice must be a standalone deliverable: someone reading only that slice's commit",
    'must understand why the change exists, without knowing what comes after it.',
    'Fold prerequisite edits (type additions, builders, small refactors) into the slice that',
    'uses them — a slice that only prepares for later slices is forbidden.',
    'Prefer fewer, feature-shaped slices; "small" means reviewable, never meaningless on its own.',
    'Size each slice so a reviewer can skim-review it in about 10 minutes — if a slice would',
    'take noticeably longer, split it along feature seams, not into bare prerequisite steps.',
    'Every slice description must start with "Implements plan step N" — the number of the',
    'plan step (from the implementation plan above) the slice delivers.',
    '',
    'Respond with JSON matching an array of:',
    '{ "id": string (kebab-case, unique), "title": string, "description": string }.',
    'Order the array the way the slices must be implemented.',
    structuredOutputInstruction(),
  ].join('\n');
}
```

In prepare.ts, after the feature-plan block (`await writePlan(paths, planOutput);`) and before the slice-plan block, insert:

```ts
const designPath = path.join(paths.stateDir, 'design.md');
const planPath = path.join(paths.stateDir, 'plan.md');
logRun(runId, 'planning: design…');
await resetStructuredOutput(repoRoot);
const designResult = await provider.run({
  cwd: repoRoot,
  prompt: buildDesignPrompt(
    rawRequest,
    contextOutput.repoSummary,
    planOutput.summary,
    planOutput.approach,
    designPath,
    planPath,
  ),
});
if (!designResult.success) throw new Error(`Design step failed: ${designResult.output}`);
await readStructuredOutput(repoRoot, (raw) => designAckSchema.parse(raw));
await resetStructuredOutput(repoRoot);
await assertPlanningDocsWritten(designPath, planPath);
```

Add near the other schemas:

```ts
const designAckSchema = z.object({ written: z.array(z.string()) });
```

Add at the bottom of prepare.ts:

```ts
async function assertPlanningDocsWritten(designPath: string, planPath: string): Promise<void> {
  const missing: string[] = [];
  for (const [name, filePath] of [
    ['design.md', designPath],
    ['plan.md', planPath],
  ] as const) {
    let ok = false;
    try {
      ok = (await readFile(filePath, 'utf-8')).trim().length > 0;
    } catch {
      ok = false;
    }
    if (!ok) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `Design step did not produce ${missing.join(' and ')} at the requested paths — ` +
        `expected non-empty markdown files; the run cannot be sliced without a plan.`,
    );
  }
}
```

Update the imports at the top of prepare.ts: `import { readFile } from 'node:fs/promises';` and add `buildDesignPrompt` to the prompts import. Change the slice-plan call to:

```ts
const sliceResult = await provider.run({
  cwd: repoRoot,
  prompt: buildSlicePlanPrompt(await readFile(planPath, 'utf-8')),
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/prepare.test.ts`
Expected: PASS (all tests, including the renumbered fakes).

- [ ] **Step 6: Full suite — other tests may reference the old prompt**

Run: `npm test`
Expected: tests/orchestrator/end-to-end.test.ts may break — it drives prepareRun with a fake provider. If it fails, update its fake the same way (extra design-step call writing both files into the run's state dir). Do not change test expectations elsewhere; if review-step or prompts tests fail, fix the code, not the tests.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/prepare.ts src/orchestrator/prompts.ts tests/orchestrator/prepare.test.ts tests/orchestrator/end-to-end.test.ts
git -c commit.gpgsign=false commit -m "Add a design step producing design.md and plan.md for slicing"
```

---

### Task 2: designGate config value

**Files:**

- Modify: `src/config/load-config.ts`
- Test: `tests/config/load-config.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `JigConfig.designGate: 'auto' | 'checkpoint'` (default `'auto'`).

- [ ] **Step 1: Write the failing tests**

In `tests/config/load-config.test.ts`, extend the defaults test with `expect(config.designGate).toBe('auto');` and add:

```ts
it('accepts designGate checkpoint', async () => {
  repo = await createTempRepo();
  await writeFile(
    path.join(repo.dir, 'jig.config.json'),
    JSON.stringify({ designGate: 'checkpoint' }),
  );
  expect(loadConfig(repo.dir).designGate).toBe('checkpoint');
});

it('throws on an invalid designGate value', async () => {
  repo = await createTempRepo();
  await writeFile(path.join(repo.dir, 'jig.config.json'), JSON.stringify({ designGate: 'maybe' }));
  expect(() => loadConfig(repo.dir)).toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config/load-config.test.ts`
Expected: FAIL — `designGate` undefined; invalid value not rejected.

- [ ] **Step 3: Implement**

In `src/config/load-config.ts` configSchema add:

```ts
// 'auto' (default): implementation starts immediately after planning.
// 'checkpoint': the autopilot command stops after planning so a human can
// read design.md/plan.md and resumes with `jig resume`.
designGate: z.enum(['auto', 'checkpoint']).default('auto'),
```

- [ ] **Step 4: Run to verify pass, commit**

Run: `npx vitest run tests/config/load-config.test.ts && npm test`
Expected: PASS.

```bash
git add src/config/load-config.ts tests/config/load-config.test.ts
git -c commit.gpgsign=false commit -m "Add designGate config value"
```

---

### Task 3: Checkpoint stop in the autopilot command

**Files:**

- Modify: `src/cli/commands/autopilot.ts`
- Test: `tests/cli/commands/autopilot.test.ts`

**Interfaces:**

- Consumes: `config.designGate` (Task 2), `prepareRun`, `loadCliRunContext`, run state docs at `paths.stateDir/design.md` and `paths.stateDir/plan.md`.
- Produces: `jig autopilot` in checkpoint mode prints doc paths and exits 0 WITHOUT calling `runAutopilot`; `resume` is unchanged (never gates).

- [ ] **Step 1: Write the failing test**

Add a new describe block to `tests/cli/commands/autopilot.test.ts` (module mocks at top, next to the existing reconcile mock):

```ts
vi.mock('../../../src/orchestrator/prepare.js', () => ({ prepareRun: vi.fn() }));
vi.mock('../../../src/cli/run-context.js', () => ({
  loadCliRunContext: vi.fn(),
  selectProvider: vi.fn(),
}));
vi.mock('../../../src/config/load-config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../../src/strategies/input-source/markdown-file.js', () => ({
  MarkdownFileInputSource: vi.fn(),
}));

import { registerAutopilotCommands } from '../../../src/cli/commands/autopilot.js';
import { prepareRun } from '../../../src/orchestrator/prepare.js';
import { loadConfig } from '../../../src/config/load-config.js';
import { loadCliRunContext, selectProvider } from '../../../src/cli/run-context.js';

describe('autopilot command with designGate checkpoint', () => {
  it('stops after planning without running the reconciler', async () => {
    const config = {
      mergeMode: 'manual',
      reviewCycleCap: 3,
      conflictResolveCap: 3,
      inputSource: 'markdown-file' as const,
      planner: { provider: 'claude' as const },
      implementer: { provider: 'claude' as const },
      reviewer: { provider: 'claude' as const },
      commitSigning: 'repo' as const,
      designGate: 'checkpoint' as const,
    };
    vi.mocked(prepareRun).mockResolvedValue({
      runId: 'r1',
      baseBranch: 'main',
      currentSliceId: 's1',
      createdAt: '',
      updatedAt: '',
    });
    vi.mocked(loadCliRunContext).mockResolvedValue({
      repoRoot: '/tmp/repo',
      paths: {
        runId: 'r1',
        repoRoot: '/tmp/repo',
        stateDir: '/tmp/repo/.jig/r1/state',
        workspaceDir: '/tmp/repo/.jig/r1/workspace',
      },
      baseBranch: 'main',
      config,
      mergeStrategy: { merge: vi.fn() },
    });
    vi.mocked(selectProvider).mockReturnValue({ run: vi.fn() });
    vi.mocked(loadConfig).mockReturnValue(config);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerAutopilotCommands(program);
    await program.parseAsync(['node', 'jig', 'autopilot', '--input', 'request.md']);

    expect(vi.mocked(runReconcilerPass)).not.toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('design.md'))).toBe(true);
    expect(logged.some((line) => line.includes('jig resume --run r1'))).toBe(true);
  });
});
```

Add `import { Command } from 'commander';` to the test file imports. Note: `runAutopilot` calls `runReconcilerPass` — asserting `runReconcilerPass` was not called proves the reconciler never ran; keep the existing reconcile mock line at the top of the file.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cli/commands/autopilot.test.ts`
Expected: FAIL — command runs the reconciler and prints the run result instead of stopping.

- [ ] **Step 3: Implement**

In `registerAutopilotCommands`'s autopilot action, after `const context = await loadCliRunContext(repoRoot, meta.runId);` insert:

```ts
if (config.designGate === 'checkpoint') {
  console.log(`Design: ${path.join(context.paths.stateDir, 'design.md')}`);
  console.log(`Plan:   ${path.join(context.paths.stateDir, 'plan.md')}`);
  console.log(
    `Run ${meta.runId} planning complete — review the design and plan, then run ` +
      `jig resume --run ${meta.runId} to start implementation.`,
  );
  return;
}
```

Add `import path from 'node:path';` at the top if not present. The two existing blocks (`provider`/`implementProvider` selection before `prepareRun`) stay as-is — the gate sits between context loading and `runAutopilot`.

- [ ] **Step 4: Run to verify pass, commit**

Run: `npx vitest run tests/cli/commands/autopilot.test.ts && npm test`
Expected: PASS.

```bash
git add src/cli/commands/autopilot.ts tests/cli/commands/autopilot.test.ts
git -c commit.gpgsign=false commit -m "Stop autopilot after planning when designGate is checkpoint"
```

---

### Task 4: status prints planning doc paths

**Files:**

- Modify: `src/cli/commands/status.ts`
- Create: `tests/cli/commands/status.test.ts`

**Interfaces:**

- Consumes: `paths.stateDir`, `existsSync` from `node:fs`.
- Produces: `jig status --run <id>` prints `Design: <path>` and `Plan: <path>` lines when the files exist.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/commands/status.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { registerStatusCommand } from '../../../src/cli/commands/status.js';
import { initializeRunState } from '../../../src/state/store.js';
import { createTempRepo, type TempRepo } from '../../support/temp-repo.js';
import { Command } from 'commander';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
  vi.restoreAllMocks();
});

describe('status command', () => {
  it('prints the planning doc paths when they exist', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    await writeFile(path.join(paths.stateDir, 'design.md'), '# Design');
    await writeFile(path.join(paths.stateDir, 'plan.md'), '# Plan');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(['node', 'jig', 'status', '--run', 'run1']);

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(
      logged.some((line) => line.includes(`Design: ${path.join(paths.stateDir, 'design.md')}`)),
    ).toBe(true);
    expect(
      logged.some((line) => line.includes(`Plan: ${path.join(paths.stateDir, 'plan.md')}`)),
    ).toBe(true);
  });

  it('prints no planning doc lines for a run without docs', async () => {
    repo = await createTempRepo();
    await initializeRunState(repo.dir, 'run1', 'main');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(['node', 'jig', 'status', '--run', 'run1']);

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('Design:'))).toBe(false);
    expect(logged.some((line) => line.includes('Plan:'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cli/commands/status.test.ts`
Expected: FAIL — status never prints doc paths.

- [ ] **Step 3: Implement**

In `src/cli/commands/status.ts`, after the `Run ...` console.log line:

```ts
for (const [label, filename] of [
  ['Design', 'design.md'],
  ['Plan', 'plan.md'],
] as const) {
  const docPath = path.join(paths.stateDir, filename);
  if (existsSync(docPath)) console.log(`${label}: ${docPath}`);
}
```

Add imports: `import { existsSync } from 'node:fs';` and `import path from 'node:path';`.

- [ ] **Step 4: Run to verify pass, commit**

Run: `npx vitest run tests/cli/commands/status.test.ts && npm test`
Expected: PASS.

```bash
git add src/cli/commands/status.ts tests/cli/commands/status.test.ts
git -c commit.gpgsign=false commit -m "Show planning doc paths in status"
```

---

### Task 5: create-pr builds the PR description from design + plan + slice mapping

**Files:**

- Modify: `src/strategies/pr/local.ts`
- Modify: `src/cli/commands/create-pr.ts`
- Test: `tests/strategies/pr/local.test.ts`

**Interfaces:**

- Consumes: `readRunMeta`, `readSlices` from `src/state/store.js`; `paths.stateDir/design.md`, `paths.stateDir/plan.md`.
- Produces: `LocalPrCreateStrategy.create(paths, slice)` (signature unchanged) now writes a `PR_DESCRIPTION.md` containing: `## Design` + design.md content, `## Plan` + plan.md content, `## Slices` — one `- <id> — <description>` line per slice, current slice prefixed `**▶` and suffixed `**(this PR)**`. Sections are omitted gracefully when the docs don't exist (pre-artifact runs).

- [ ] **Step 1: Write the failing tests**

In `tests/strategies/pr/local.test.ts`, add below the existing test (the existing test keeps passing — it uses no docs):

```ts
it('embeds the design and plan and marks the current slice in the mapping', async () => {
  repo = await createTempRepo();
  const paths = getRunPaths(repo.dir, 'run2');
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(path.join(paths.stateDir, 'design.md'), '# Design\n\nA route returning 200.');
  await writeFile(path.join(paths.stateDir, 'plan.md'), '# Plan\n\n## Step 1 — Add health route');
  const { initializeRunState, writeSlices, readRunMeta, writeRunMeta } =
    await import('../../../src/state/store.js');
  const paths2 = await initializeRunState(repo.dir, 'run2', 'main');
  const s1: Slice = {
    id: 's1',
    title: 'Add health route',
    description: 'Implements plan step 1. Adds GET /health returning 200.',
    order: 0,
    status: 'ready_to_merge',
    branch: 'jig/slice/run2/s1',
    reviewCycles: 0,
    mergeAttempts: 0,
  };
  const s2: Slice = {
    ...s1,
    id: 's2',
    title: 'Second',
    description: 'Implements plan step 2. Wire the route into the app.',
    order: 1,
    status: 'pending',
    branch: 'jig/slice/run2/s2',
  };
  await writeSlices(paths2, [s1, s2]);
  const meta = await readRunMeta(paths2);
  await writeRunMeta(paths2, { ...meta, currentSliceId: 's1' });

  await new LocalPrCreateStrategy().create(paths2, s1);

  const content = await readFile(path.join(paths2.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
  expect(content).toContain('## Design');
  expect(content).toContain('A route returning 200.');
  expect(content).toContain('## Plan');
  expect(content).toContain('## Step 1 — Add health route');
  expect(content).toContain('**▶ s1 — Implements plan step 1. Adds GET /health returning 200.**');
  expect(content).toContain('- s2 — Implements plan step 2. Wire the route into the app.');
});

it('omits the design and plan sections when the run has no planning docs', async () => {
  repo = await createTempRepo();
  const paths = getRunPaths(repo.dir, 'run3');
  await mkdir(paths.stateDir, { recursive: true });
  const slice: Slice = {
    id: 's1',
    title: 'Add health route',
    description: 'Adds GET /health returning 200.',
    order: 0,
    status: 'ready_to_merge',
    branch: 'jig/slice/run3/s1',
    reviewCycles: 0,
    mergeAttempts: 0,
  };

  await new LocalPrCreateStrategy().create(paths, slice);

  const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
  expect(content).not.toContain('## Design');
  expect(content).not.toContain('## Plan');
  expect(content).toContain('Add health route');
});
```

Add `writeFile` to the `node:fs/promises` import at the top.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/strategies/pr/local.test.ts`
Expected: FAIL — description has no Design/Plan/mapping sections.

- [ ] **Step 3: Implement**

Rewrite `src/strategies/pr/local.ts`:

```ts
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readRunMeta, readSlices } from '../../state/store.js';
import type { RunPaths } from '../../state/run-paths.js';
import type { Slice } from '../../state/types.js';
import type { PrCreateStrategy } from './types.js';

export class LocalPrCreateStrategy implements PrCreateStrategy {
  async create(paths: RunPaths, slice: Slice): Promise<void> {
    const content = [
      `# ${slice.title}`,
      '',
      slice.description,
      '',
      ...(await this.planningSections(paths)),
      await this.sliceMapping(paths, slice),
    ].join('\n');
    // Written to stateDir, not workspaceDir: stateDir isn't even part of the
    // workspace worktree's git working tree, so this file can never be swept
    // into a commit by a later `commitAll` — unlike workspaceDir, which is
    // exactly the mistake that landed agent scratch files in user history.
    await writeFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), content, 'utf-8');
  }

  private async planningSections(paths: RunPaths): Promise<string[]> {
    const sections: string[] = [];
    for (const [title, filename] of [
      ['## Design', 'design.md'],
      ['## Plan', 'plan.md'],
    ] as const) {
      const docPath = path.join(paths.stateDir, filename);
      if (!existsSync(docPath)) continue;
      sections.push(title, '', (await readFile(docPath, 'utf-8')).trim(), '');
    }
    return sections;
  }

  private async sliceMapping(paths: RunPaths, slice: Slice): Promise<string> {
    const slices = await readSlices(paths);
    const lines = slices.map((s) => {
      const entry = `- ${s.id} — ${s.description.split('\n')[0]}`;
      return s.id === slice.id ? entry.replace(/^- /, '**▶ ') + '**' : entry;
    });
    return ['## Slices', '', ...lines].join('\n');
  }
}
```

`create-pr.ts` needs no changes (it already prints the output path).

- [ ] **Step 4: Run to verify pass, commit**

Run: `npx vitest run tests/strategies/pr/local.test.ts && npm test`
Expected: PASS.

```bash
git add src/strategies/pr/local.ts tests/strategies/pr/local.test.ts
git -c commit.gpgsign=false commit -m "Build PR description from design, plan, and slice mapping"
```

---

### Task 6: Run-exit summary prints planning doc paths

**Files:**

- Modify: `src/cli/run-summary.ts`
- Test: `tests/cli/run-summary.test.ts`

**Interfaces:**

- Consumes: `paths.stateDir`, `existsSync`.
- Produces: `printRunSummary` additionally prints `Design: <path>` and `Plan: <path>` lines when the files exist — so blocked/complete autopilot and resume exits always point at the docs.

- [ ] **Step 1: Write the failing test**

In `tests/cli/run-summary.test.ts`, extend the first test (`prints the worktree path and the commits…`): before `printRunSummary` is called, add `await writeFile(path.join(paths.stateDir, 'design.md'), '# Design');` and `await writeFile(path.join(paths.stateDir, 'plan.md'), '# Plan');` (writeFile is already imported), and after it assert:

```ts
expect(
  logged.some((line) => line.includes(`Design: ${path.join(paths.stateDir, 'design.md')}`)),
).toBe(true);
expect(logged.some((line) => line.includes(`Plan: ${path.join(paths.stateDir, 'plan.md')}`))).toBe(
  true,
);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cli/run-summary.test.ts`
Expected: FAIL — no Design/Plan lines.

- [ ] **Step 3: Implement**

In `src/cli/run-summary.ts`, right after `console.log(`Worktree: ${paths.workspaceDir}`);`:

```ts
for (const [label, filename] of [
  ['Design', 'design.md'],
  ['Plan', 'plan.md'],
] as const) {
  const docPath = path.join(paths.stateDir, filename);
  if (existsSync(docPath)) console.log(`${label}: ${docPath}`);
}
```

Add `import { existsSync } from 'node:fs';` at the top.

- [ ] **Step 4: Run to verify pass, full verification, commit**

Run: `npm test && npx tsc -p tsconfig.json --noEmit && npm run lint && npx prettier --check src tests`
Expected: all PASS.

```bash
git add src/cli/run-summary.ts tests/cli/run-summary.test.ts
git -c commit.gpgsign=false commit -m "Point run-exit summary at the planning docs"
```
