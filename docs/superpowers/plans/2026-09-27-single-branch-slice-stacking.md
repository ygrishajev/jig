# Single Run Branch / Single Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace jig's per-slice branch-and-merge model with a single run branch: every slice's commits stack on one branch, and the whole feature merges into the base branch once, in one PR, after every slice has been approved.

**Architecture:** Each run gets one derived branch, `jig/run/<runId>`, instead of one branch per slice (`jig/slice/<runId>/<sliceId>`). The implement step always works on that one branch, so slice 2's commits sit on top of slice 1's. The reconciler no longer merges anything per slice — a slice reaching `ready_to_merge` is immediately marked `merged` (meaning "folded into the run branch", not "merged into base") and the reconciler advances to the next slice with zero git action. Only once every slice is `merged` does a new `finalizeRun` step (replacing `advance.ts`) attempt the single git merge of the run branch into the base branch, gated by `mergeStrategy` exactly the way slice merges were gated before (manual mode waits for a human `jig merge`, auto mode does it immediately).

**Tech Stack:** TypeScript, vitest, simple-git, execa, commander, zod — no new dependencies.

**Spec:** No separate spec document exists — the design was agreed inline during a conversation about why per-slice merge-gating idles an async worker for small changes. This plan's Architecture section above is the spec of record; the conversation's reasoning (stacking removes the wait without needing bounded/throttled stacking) is the rationale, not repeated per-task.

## Global Constraints

- No new dependencies.
- Preserve existing `mergeMode: 'manual' | 'auto'` semantics exactly — apply them once per run instead of once per slice. Manual mode must still never touch git on its own; auto mode must still merge immediately once merging is due.
- Preserve `reviewCycleCap` / `stuck` behavior unchanged — per-slice AI review still happens for every slice, only the post-approval merge step changes.
- `Slice.mergeAttempts` stays as-is (already unused elsewhere; removing it is out of scope for this change).
- No migration path for on-disk state from runs created before this change. A `.jig/<runId>/state/slices.json` written by the old code has a `branch` field the new stricter zod schema doesn't expect but does not reject (zod objects allow extra keys by default unless `.strict()` is used, and `sliceSchema` isn't `.strict()`), so old slice files still parse — but any such run should be treated as stale and restarted, not resumed, since its slices reference per-slice branches (`jig/slice/...`) nothing in the new code creates or looks for anymore. Do not add a shim to bridge old and new state.

---

## Task 1: State layer — one branch per run, not per slice

**Files:**

- Modify: `src/state/types.ts`
- Test: `tests/state/types.test.ts`
- Test: `tests/state/store.test.ts`

**Interfaces:**

- Produces: `runBranchFor(runId: string): string` — every later task that needs the run's branch name calls this instead of reading `slice.branch` (which no longer exists).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test for `runBranchFor` and the narrowed `Slice` shape**

Replace the whole contents of `tests/state/types.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import {
  runBranchFor,
  runMetaSchema,
  sliceSchema,
  sliceStatusSchema,
  slicesSchema,
} from '../../src/state/types.js';

describe('state schemas', () => {
  it('accepts every status defined in the slice status enum', () => {
    const statuses = ['pending', 'implementing', 'in_review', 'ready_to_merge', 'merged', 'stuck'];
    for (const status of statuses) {
      expect(sliceStatusSchema.parse(status)).toBe(status);
    }
  });

  it('accepts a valid slice list', () => {
    const parsed = slicesSchema.parse([
      {
        id: 'add-auth-middleware',
        title: 'Add auth middleware',
        description: 'Add the auth middleware that checks the session token.',
        order: 0,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ]);
    expect(parsed).toHaveLength(1);
  });

  it('rejects an invalid slice status', () => {
    expect(() =>
      slicesSchema.parse([
        {
          id: 'x',
          title: 'x',
          description: 'x',
          order: 0,
          status: 'not-a-real-status',
          reviewCycles: 0,
          mergeAttempts: 0,
        },
      ]),
    ).toThrow();
  });

  it('accepts a slice with lastFeedback set and defaults it to undefined when absent', () => {
    const withFeedback = sliceSchema.parse({
      id: 'x',
      title: 'x',
      description: 'x',
      order: 0,
      status: 'pending',
      reviewCycles: 1,
      mergeAttempts: 0,
      lastFeedback: 'Missing a test for the error path.',
    });
    expect(withFeedback.lastFeedback).toBe('Missing a test for the error path.');

    const withoutFeedback = sliceSchema.parse({
      id: 'y',
      title: 'y',
      description: 'y',
      order: 0,
      status: 'pending',
      reviewCycles: 0,
      mergeAttempts: 0,
    });
    expect(withoutFeedback.lastFeedback).toBeUndefined();
  });

  it('rejects a slice id with characters unsafe for a stable lookup key', () => {
    expect(() =>
      sliceSchema.parse({
        id: 'Add Auth/Middleware!',
        title: 'x',
        description: 'x',
        order: 0,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      }),
    ).toThrow(/lowercase/);
  });

  it('parses run meta', () => {
    const meta = runMetaSchema.parse({
      runId: 'abc12345',
      baseBranch: 'main',
      currentSliceId: null,
      createdAt: '2026-09-25T00:00:00.000Z',
      updatedAt: '2026-09-25T00:00:00.000Z',
    });
    expect(meta.runId).toBe('abc12345');
  });

  it('derives one stable branch name per run id, not per slice', () => {
    expect(runBranchFor('abc12345')).toBe('jig/run/abc12345');
    expect(runBranchFor('abc12345')).toBe(runBranchFor('abc12345'));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/state/types.test.ts`
Expected: FAIL — `runBranchFor` is not exported from `src/state/types.js`, and the "accepts a valid slice list" style tests currently require a `branch` field that isn't in the fixtures above (they'll fail parsing for the opposite reason today — `sliceSchema` currently requires `branch`, so omitting it fails validation).

- [ ] **Step 3: Update the one-line edit in `tests/state/store.test.ts`**

In `tests/state/store.test.ts`, find the slice literal inside the `'round-trips slices through write and read'` test:

```ts
      {
        id: 's1',
        title: 'First slice',
        description: 'Does the first thing.',
        order: 0,
        status: 'pending',
        branch: 'jig/slice/run2/s1',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
```

Delete the `branch: 'jig/slice/run2/s1',` line so it reads:

```ts
      {
        id: 's1',
        title: 'First slice',
        description: 'Does the first thing.',
        order: 0,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
```

- [ ] **Step 4: Implement `runBranchFor` and drop `Slice.branch`**

Replace the whole contents of `src/state/types.ts` with:

```ts
import { z } from 'zod';

// A slice id is used as a stable lookup key across state files and log
// lines, so it's constrained to characters that are always safe there rather
// than accepting arbitrary agent-provided text.
export const sliceIdPattern = /^[a-z0-9-]+$/;

export const sliceStatusSchema = z.enum([
  'pending',
  'implementing',
  'in_review',
  'ready_to_merge',
  'merged',
  'stuck',
]);
export type SliceStatus = z.infer<typeof sliceStatusSchema>;

export const sliceSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(sliceIdPattern, 'slice id must be lowercase alphanumeric characters and hyphens only'),
  title: z.string().min(1),
  description: z.string().min(1),
  order: z.number().int().nonnegative(),
  status: sliceStatusSchema,
  reviewCycles: z.number().int().nonnegative(),
  mergeAttempts: z.number().int().nonnegative(),
  lastFeedback: z.string().optional(),
});
export type Slice = z.infer<typeof sliceSchema>;

export const slicesSchema = z.array(sliceSchema);

export const runContextSchema = z.object({
  rawRequest: z.string(),
  classification: z.string(),
  repoSummary: z.string(),
  createdAt: z.string(),
});
export type RunContext = z.infer<typeof runContextSchema>;

export const runPlanSchema = z.object({
  summary: z.string(),
  approach: z.string(),
  affectedAreas: z.array(z.string()),
});
export type RunPlan = z.infer<typeof runPlanSchema>;

export const runMetaSchema = z.object({
  runId: z.string().min(1),
  baseBranch: z.string().min(1),
  currentSliceId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunMeta = z.infer<typeof runMetaSchema>;

/**
 * Every slice in a run commits onto this single branch — one branch per run,
 * not one per slice — so the whole feature lands as one merge/PR.
 */
export function runBranchFor(runId: string): string {
  return `jig/run/${runId}`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/state/types.test.ts tests/state/store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/state/types.ts tests/state/types.test.ts tests/state/store.test.ts
git commit -m "sdlc: derive one branch per run instead of one per slice"
```

---

## Task 2: One run-level merge (`finalizeRun` replaces `advance.ts`)

**Files:**

- Create: `src/orchestrator/finalize-run.ts`
- Delete: `src/orchestrator/advance.ts`
- Modify: `src/strategies/merge/types.ts`
- Modify: `src/strategies/merge/auto.ts`
- Modify: `src/strategies/merge/manual.ts`
- Test: Create `tests/orchestrator/finalize-run.test.ts`
- Test: Delete `tests/orchestrator/advance.test.ts`

**Interfaces:**

- Consumes: `runBranchFor` from Task 1, `isBranchMergedInto`/`mergeBranchInto` from `src/git/merge.ts` (unchanged), `logRun` from `src/logging.ts` (unchanged).
- Produces: `finalizeRun(input: { repoRoot: string; paths: RunPaths; baseBranch: string; mergeStrategy: MergeStrategy }): Promise<{ blocked: boolean; reason?: string; complete: boolean }>` — Task 5 (reconciler) calls this once, after the last slice is done. `MergeStrategy.merge` now takes `(repoRoot: string, branchName: string, baseBranch: string)` instead of a `Slice`.

- [ ] **Step 1: Write the failing test**

Create `tests/orchestrator/finalize-run.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finalizeRun } from '../../src/orchestrator/finalize-run.js';
import { AutoMergeStrategy } from '../../src/strategies/merge/auto.js';
import { ManualMergeStrategy } from '../../src/strategies/merge/manual.js';
import { checkoutExistingBranch, checkoutNewBranchAt } from '../../src/git/branch.js';
import { commitAll } from '../../src/git/repository.js';
import { mergeBranchInto } from '../../src/git/merge.js';
import { initializeRunState } from '../../src/state/store.js';
import { runBranchFor } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

async function commitOnRunBranch(repoDir: string, runId: string, filename: string): Promise<void> {
  await checkoutNewBranchAt(repoDir, runBranchFor(runId), 'main');
  await writeFile(path.join(repoDir, filename), 'x');
  await commitAll(repoDir, `implement ${filename}`);
  await checkoutExistingBranch(repoDir, 'main');
}

describe('finalizeRun', () => {
  it('logs which run branch was merged into which base branch', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'runlog', 'main');
    await commitOnRunBranch(repo.dir, 'runlog', 'first.txt');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('[jig runlog]'))).toBe(true);
    expect(
      logged.some((line) => line.includes('run branch "jig/run/runlog" merged into "main"')),
    ).toBe(true);
  });

  it('auto-merges the run branch and reports the run complete', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    await commitOnRunBranch(repo.dir, 'run1', 'first.txt');

    const result = await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result).toEqual({ blocked: false, complete: true });
  });

  it('detects a manual merge already performed and reports complete without merging itself', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run2', 'main');
    await commitOnRunBranch(repo.dir, 'run2', 'first.txt');
    await mergeBranchInto(repo.dir, runBranchFor('run2'), 'main');

    const result = await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result).toEqual({ blocked: false, complete: true });
  });

  it('reports blocked when manual mode has not merged the run branch yet', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3', 'main');
    await commitOnRunBranch(repo.dir, 'run3', 'first.txt');

    const result = await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('not yet merged');
  });

  it('turns a real merge conflict into a blocked result instead of throwing', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4', 'main');
    await checkoutNewBranchAt(repo.dir, runBranchFor('run4'), 'main');
    await writeFile(path.join(repo.dir, 'README.md'), 'from run branch\n');
    await commitAll(repo.dir, 'change readme on run branch');
    await checkoutExistingBranch(repo.dir, 'main');
    await writeFile(path.join(repo.dir, 'README.md'), 'from main\n');
    await commitAll(repo.dir, 'change readme on main');

    const result = await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.blocked).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('merge failed');
  });

  it('reports blocked, not complete, when the run branch does not exist yet', async () => {
    // A run whose first slice hasn't implemented anything yet has no run
    // branch at all — isBranchMergedInto's catch path treats a nonexistent
    // branch as "not merged", so this pins that case as blocked rather than
    // a false "complete".
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run5', 'main');

    const result = await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(true);
    expect(result.complete).toBe(false);
  });
});
```

Delete `tests/orchestrator/advance.test.ts` — every scenario it covered is either superseded by the tests above (run-level merge/conflict/manual-detection) or moves to Task 5's `reconcile.test.ts` (per-slice ordering/advancement, which no longer touches git at all).

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/orchestrator/finalize-run.test.ts`
Expected: FAIL — `src/orchestrator/finalize-run.js` does not exist yet.

- [ ] **Step 3: Change the `MergeStrategy` interface and both implementations**

Replace the whole contents of `src/strategies/merge/types.ts` with:

```ts
export interface MergeStrategy {
  merge(repoRoot: string, branchName: string, baseBranch: string): Promise<void>;
}
```

Replace the whole contents of `src/strategies/merge/auto.ts` with:

```ts
import { mergeBranchInto } from '../../git/merge.js';
import type { MergeStrategy } from './types.js';

export class AutoMergeStrategy implements MergeStrategy {
  async merge(repoRoot: string, branchName: string, baseBranch: string): Promise<void> {
    await mergeBranchInto(repoRoot, branchName, baseBranch);
  }
}
```

Replace the whole contents of `src/strategies/merge/manual.ts` with:

```ts
import type { MergeStrategy } from './types.js';

export class ManualMergeStrategy implements MergeStrategy {
  async merge(_repoRoot: string, _branchName: string, _baseBranch: string): Promise<void> {
    // Intentionally does nothing: merging into the base branch is left to the
    // operator's own git workflow. finalizeRun still detects a manual merge
    // by checking git state directly, which is what lets `resume` continue.
  }
}
```

- [ ] **Step 4: Create `finalize-run.ts` and delete `advance.ts`**

Create `src/orchestrator/finalize-run.ts`:

```ts
import { isBranchMergedInto } from '../git/merge.js';
import { logRun } from '../logging.js';
import { runBranchFor } from '../state/types.js';
import type { RunPaths } from '../state/run-paths.js';
import type { MergeStrategy } from '../strategies/merge/types.js';

export interface FinalizeRunInput {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
  mergeStrategy: MergeStrategy;
}

export interface FinalizeRunResult {
  blocked: boolean;
  reason?: string;
  complete: boolean;
}

/**
 * The run's single feature branch — every slice's commits land here — is
 * merged into baseBranch exactly once, after every slice has been approved.
 * This is the only git-merge action the whole run performs.
 */
export async function finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult> {
  const { repoRoot, paths, baseBranch, mergeStrategy } = input;
  const branch = runBranchFor(paths.runId);
  if (await isBranchMergedInto(repoRoot, branch, baseBranch)) {
    return { blocked: false, complete: true };
  }
  try {
    await mergeStrategy.merge(repoRoot, branch, baseBranch);
    if (await isBranchMergedInto(repoRoot, branch, baseBranch)) {
      logRun(paths.runId, `run branch "${branch}" merged into "${baseBranch}"`);
      return { blocked: false, complete: true };
    }
    return {
      blocked: true,
      reason: `run branch "${branch}" is not yet merged into "${baseBranch}"`,
      complete: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      blocked: true,
      reason: `merge failed for run branch "${branch}": ${message}`,
      complete: false,
    };
  }
}
```

Delete `src/orchestrator/advance.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/orchestrator/finalize-run.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/finalize-run.ts src/strategies/merge/types.ts src/strategies/merge/auto.ts src/strategies/merge/manual.ts tests/orchestrator/finalize-run.test.ts
git rm src/orchestrator/advance.ts tests/orchestrator/advance.test.ts
git commit -m "sdlc: merge the run's branch once, in finalizeRun, instead of per slice"
```

Note: this leaves `src/orchestrator/reconcile.ts` and `src/cli/commands/merge.ts` importing the now-deleted `advance.js` — that's expected and fixed in Tasks 5 and 8. `npm run build` will fail until then; do not run it as a gate for this task.

---

## Task 3: Implement step commits onto the run branch

**Files:**

- Modify: `src/orchestrator/implement-step.ts`
- Test: `tests/orchestrator/implement-step.test.ts`

**Interfaces:**

- Consumes: `runBranchFor` from Task 1.
- Produces: no signature change to `runImplementStep` — same `ImplementStepInput`/behavior, just a different (shared) branch name.

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `tests/orchestrator/implement-step.test.ts` with:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ImplementStepFailedError,
  runImplementStep,
} from '../../src/orchestrator/implement-step.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { getRunPaths } from '../../src/state/run-paths.js';
import { isWorkingTreeClean } from '../../src/git/repository.js';
import { getCurrentBranch } from '../../src/git/branch.js';
import type { Slice } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

function makeSlice(overrides: Partial<Slice> = {}): Slice {
  return {
    id: 's1',
    title: 'First slice',
    description: 'Do the first thing.',
    order: 0,
    status: 'pending',
    reviewCycles: 0,
    mergeAttempts: 0,
    ...overrides,
  };
}

describe('runImplementStep', () => {
  it('logs which slice it is implementing and the worktree path, prefixed by the run id', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'runlog');
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(path.join(input.cwd, 'health.ts'), 'export const health = () => "ok";\n');
      return { success: true, output: 'implemented' };
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes(`[jig runlog]`))).toBe(true);
    expect(logged.some((line) => line.includes('implementing slice "s1"'))).toBe(true);
    expect(logged.some((line) => line.includes(paths.workspaceDir))).toBe(true);
  });

  it('creates the workspace on the run branch, runs the provider, commits, and advances status', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run1');
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(path.join(input.cwd, 'health.ts'), 'export const health = () => "ok";\n');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    expect(slice.status).toBe('in_review');
    expect(await getCurrentBranch(paths.workspaceDir)).toBe('jig/run/run1');
    expect(await isWorkingTreeClean(paths.workspaceDir)).toBe(true);
  });

  it('reuses the run branch on a second call (e.g. the next slice) instead of recreating it', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run2');
    const slice = makeSlice();
    let calls = 0;
    const provider = new FakeAgentProvider(async (input) => {
      calls += 1;
      await writeFile(path.join(input.cwd, `pass-${calls}.txt`), 'x');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });
    slice.status = 'pending';
    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    expect(calls).toBe(2);
    expect(await getCurrentBranch(paths.workspaceDir)).toBe('jig/run/run2');
  });

  it('throws and leaves status untouched when the provider fails', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run3');
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async () => ({ success: false, output: 'boom' }));

    await expect(
      runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider }),
    ).rejects.toThrow(ImplementStepFailedError);
    expect(slice.status).toBe('pending');
  });

  it('recreates the run branch from base when the workspace worktree exists but the branch does not', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run5');
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(path.join(input.cwd, 'first.txt'), 'x');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    const { openRepo } = await import('../../src/git/repository.js');
    await openRepo(paths.workspaceDir).raw([
      'branch',
      '-m',
      'jig/run/run5',
      'jig/run/renamed-away',
    ]);
    expect(await getCurrentBranch(paths.workspaceDir)).toBe('jig/run/renamed-away');

    slice.status = 'pending';
    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    expect(slice.status).toBe('in_review');
    expect(await getCurrentBranch(paths.workspaceDir)).toBe('jig/run/run5');
  });

  it('disables commit signing in the workspace only when skipCommitSigning is set', async () => {
    repo = await createTempRepo();
    const { openRepo } = await import('../../src/git/repository.js');
    await openRepo(repo.dir).raw(['config', 'commit.gpgsign', 'true']);
    const paths = getRunPaths(repo.dir, 'run6');
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(path.join(input.cwd, 'health.ts'), 'export const health = () => "ok";\n');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({
      repoRoot: repo.dir,
      paths,
      slice,
      baseBranch: 'main',
      provider,
      skipCommitSigning: true,
    });

    expect((await openRepo(paths.workspaceDir).raw(['config', 'commit.gpgsign'])).trim()).toBe(
      'false',
    );
    expect((await openRepo(repo.dir).raw(['config', 'commit.gpgsign'])).trim()).toBe('true');
  });

  it('includes lastFeedback in the prompt when a previous review requested changes', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run4');
    const slice = makeSlice({
      lastFeedback: 'The health check must also verify the database connection.',
    });
    let seenPrompt = '';
    const provider = new FakeAgentProvider(async (input) => {
      seenPrompt = input.prompt;
      await writeFile(path.join(input.cwd, 'health.ts'), 'export const health = () => "ok";\n');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    expect(seenPrompt).toContain('verify the database connection');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/orchestrator/implement-step.test.ts`
Expected: FAIL — the branch assertions expect `jig/run/<id>` but the code still checks out `slice.branch` (`jig/slice/<id>/s1`), and `makeSlice()` no longer produces a `branch` field the current `Slice` type requires (TypeScript compile error until Task 1's schema change, which is already in place from Task 1 — so this fails on the branch-name assertions specifically).

- [ ] **Step 3: Point `runImplementStep` at the run branch**

In `src/orchestrator/implement-step.ts`, change the import:

Old:

```ts
import type { RunPaths } from '../state/run-paths.js';
import type { Slice } from '../state/types.js';
```

New:

```ts
import type { RunPaths } from '../state/run-paths.js';
import { runBranchFor, type Slice } from '../state/types.js';
```

Then change the body of `runImplementStep`:

Old:

```ts
const { repoRoot, paths, slice, baseBranch, provider, skipCommitSigning } = input;
await ensureWorkspaceOnBranch(repoRoot, paths.workspaceDir, slice.branch, baseBranch, {
  skipCommitSigning,
});
```

New:

```ts
const { repoRoot, paths, slice, baseBranch, provider, skipCommitSigning } = input;
await ensureWorkspaceOnBranch(repoRoot, paths.workspaceDir, runBranchFor(paths.runId), baseBranch, {
  skipCommitSigning,
});
```

Nothing else in the file changes — `ensureWorkspaceOnBranch` was already generic over the branch name.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/orchestrator/implement-step.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/implement-step.ts tests/orchestrator/implement-step.test.ts
git commit -m "sdlc: implement step commits onto the run branch, not a per-slice branch"
```

---

## Task 4: Planning stops assigning a per-slice branch

**Files:**

- Modify: `src/orchestrator/prepare.ts`
- Test: `tests/orchestrator/prepare.test.ts`
- Test: `tests/orchestrator/review-step.test.ts` (dead `branch` overrides only — review step never reads `slice.branch`)

**Interfaces:**

- Consumes: nothing new (branch is no longer constructed here at all).
- Produces: `Slice` objects with no `branch` field, matching Task 1's schema.

- [ ] **Step 1: Update the assertions that reference the old per-slice branch**

In `tests/orchestrator/prepare.test.ts`, delete this line (around line 210):

```ts
expect(slices[0].branch).toBe(`jig/slice/${meta.runId}/add-health-route`);
```

Rename the test title around line 373 from:

```ts
  it('throws when the slice-plan step returns an id with characters unsafe for a git branch name', async () => {
```

to:

```ts
  it('throws when the slice-plan step returns an id with characters unsafe for a stable slice id', async () => {
```

(The test body below it is unchanged — it still asserts the same rejection via the same `id` regex.)

In `tests/orchestrator/review-step.test.ts`, remove the now-nonexistent `branch` field/overrides — `runReviewStep` never reads `slice.branch`, so these were always inert:

- Line 28: delete `    branch: 'jig/slice/run1/s1',` from `makeSlice`'s defaults.
- Line 50: change `const slice = makeSlice({ branch: 'jig/slice/runlog/s1' });` to `const slice = makeSlice();`.
- Line 72: change `const slice = makeSlice({ branch: 'jig/slice/runlog2/s1' });` to `const slice = makeSlice();`.
- Line 385: change `const slice = makeSlice({ branch: 'jig/slice/run7/s1' });` to `const slice = makeSlice();`.

- [ ] **Step 2: Run the tests to confirm the prepare assertion is gone and the rest still fails to compile**

Run: `npx vitest run tests/orchestrator/prepare.test.ts tests/orchestrator/review-step.test.ts`
Expected: FAIL — `src/orchestrator/prepare.ts` still assigns a `branch` field that no longer exists on `Slice`, which is a type error under `tsc` and (since vitest here runs through the TS loader) surfaces as a test run failure.

- [ ] **Step 3: Stop assigning `branch` in `prepare.ts`**

In `src/orchestrator/prepare.ts`, change:

Old:

```ts
const slices: Slice[] = sliceOutput.map((slice, order) => ({
  ...slice,
  order,
  status: 'pending',
  branch: `jig/slice/${runId}/${slice.id}`,
  reviewCycles: 0,
  mergeAttempts: 0,
}));
```

New:

```ts
const slices: Slice[] = sliceOutput.map((slice, order) => ({
  ...slice,
  order,
  status: 'pending',
  reviewCycles: 0,
  mergeAttempts: 0,
}));
```

Also update the stale comment above `assertUniqueSliceIds` in the same file:

Old:

```ts
// Nothing in sliceOutputSchema enforces id uniqueness even though the prompt
// asks for it. A duplicate id makes advanceRun get stuck: two slices sharing
// one id/branch means the "next non-merged slice" lookup can keep landing
// back on one that's already been merged, forever.
```

New:

```ts
// Nothing in sliceOutputSchema enforces id uniqueness even though the prompt
// asks for it. A duplicate id makes the reconciler get stuck: two slices
// sharing one id means the "next non-merged slice" lookup can keep landing
// back on one that's already been merged, forever.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/orchestrator/prepare.test.ts tests/orchestrator/review-step.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/prepare.ts tests/orchestrator/prepare.test.ts tests/orchestrator/review-step.test.ts
git commit -m "sdlc: stop assigning a per-slice branch during planning"
```

---

## Task 5: Reconciler folds slices into the run branch instead of merging each one

**Files:**

- Modify: `src/orchestrator/reconcile.ts`
- Test: `tests/orchestrator/reconcile.test.ts`

**Interfaces:**

- Consumes: `finalizeRun` from Task 2.
- Produces: `ReconcilePassInput`/`ReconcilePassResult` unchanged in shape (so `src/cli/commands/autopilot.ts` and `src/cli/commands/step.ts` need no changes).

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `tests/orchestrator/reconcile.test.ts` with:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { runReconcilerPass } from '../../src/orchestrator/reconcile.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { AutoMergeStrategy } from '../../src/strategies/merge/auto.js';
import { ManualMergeStrategy } from '../../src/strategies/merge/manual.js';
import { checkoutExistingBranch, checkoutNewBranchAt } from '../../src/git/branch.js';
import { commitAll } from '../../src/git/repository.js';
import { mergeBranchInto } from '../../src/git/merge.js';
import { structuredOutputPath } from '../../src/orchestrator/structured-output.js';
import {
  initializeRunState,
  readRunMeta,
  readSlices,
  writeRunMeta,
  writeSlices,
} from '../../src/state/store.js';
import { runBranchFor } from '../../src/state/types.js';
import type { JigConfig } from '../../src/config/load-config.js';
import type { Slice } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

const baseConfig: JigConfig = {
  mergeMode: 'manual',
  reviewCycleCap: 3,
  conflictResolveCap: 3,
  inputSource: 'markdown-file',
  planner: { provider: 'claude' },
  implementer: { provider: 'claude' },
  reviewer: { provider: 'claude' },
};

async function setUpSingleSliceRun(repoDir: string, runId: string) {
  const paths = await initializeRunState(repoDir, runId, 'main');
  const slice: Slice = {
    id: 'only',
    title: 'Only slice',
    description: 'Do the only thing.',
    order: 0,
    status: 'pending',
    reviewCycles: 0,
    mergeAttempts: 0,
  };
  await writeSlices(paths, [slice]);
  const meta = await readRunMeta(paths);
  await writeRunMeta(paths, { ...meta, currentSliceId: 'only' });
  return paths;
}

describe('runReconcilerPass', () => {
  it('drives a pending slice to in_review on one pass', async () => {
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run1');
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(`${input.cwd}/impl.txt`, 'x');
      return { success: true, output: 'ok' };
    });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(false);
    const slices = await readSlices(paths);
    expect(slices[0].status).toBe('in_review');
  });

  it('uses implementProvider instead of provider for a pending slice when set', async () => {
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run1c');
    const provider = new FakeAgentProvider(async () => ({
      success: false,
      output: 'the wrong provider ran',
    }));
    const implementProvider = new FakeAgentProvider(async (input) => {
      await writeFile(`${input.cwd}/impl.txt`, 'x');
      return { success: true, output: 'ok' };
    });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      implementProvider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    const slices = await readSlices(paths);
    expect(slices[0].status).toBe('in_review');
  });

  it('does not advance within the same pass when the review step requests changes', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1b', 'main');
    const slices: Slice[] = [
      {
        id: 'other',
        title: 'Other slice',
        description: 'Some other slice ahead in the array.',
        order: 0,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'only',
        title: 'Only slice',
        description: 'Do the only thing.',
        order: 1,
        status: 'in_review',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ];
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'only' });
    await mkdir(paths.workspaceDir, { recursive: true });
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: false, feedback: 'Needs another pass.' }),
      );
      return { success: true, output: 'reviewed' };
    });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(false);
    const updatedSlices = await readSlices(paths);
    expect(updatedSlices.find((s) => s.id === 'only')?.status).toBe('pending');
    expect(updatedSlices.find((s) => s.id === 'only')?.reviewCycles).toBe(1);
  });

  it('folds the slice into the run branch and reports blocked on the final merge once every slice is done', async () => {
    // Distinct from finalize-run.test.ts's coverage of finalizeRun itself:
    // this pins the reconciler's handoff into it — the slice's own status
    // must already read 'merged' (folded into the run branch) while the
    // run-level merge is still pending, not 'ready_to_merge'.
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run2');
    let call = 0;
    const provider = new FakeAgentProvider(async (input) => {
      call += 1;
      if (call === 1) {
        await writeFile(`${input.cwd}/impl.txt`, 'x');
      } else {
        await writeFile(
          structuredOutputPath(input.cwd),
          JSON.stringify({ approved: true, feedback: '' }),
        );
      }
      return { success: true, output: 'ok' };
    });

    await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });
    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('not yet merged');
    const slices = await readSlices(paths);
    expect(slices[0].status).toBe('merged');
    const updatedMeta = await readRunMeta(paths);
    expect(updatedMeta.currentSliceId).toBeNull();
  });

  it('completes the run in one pass when auto mode merges the run branch right after the last slice is approved', async () => {
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run4');
    const slices = await readSlices(paths);
    slices[0].status = 'ready_to_merge';
    await writeSlices(paths, slices);
    // The run branch needs real commits for finalizeRun to have anything to
    // merge — this simulates the implement step having already run.
    await checkoutNewBranchAt(repo.dir, runBranchFor('run4'), 'main');
    await writeFile(`${repo.dir}/impl.txt`, 'x');
    await commitAll(repo.dir, 'implement only');
    await checkoutExistingBranch(repo.dir, 'main');

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: { ...baseConfig, mergeMode: 'auto' },
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(true);
    const updatedSlices = await readSlices(paths);
    expect(updatedSlices[0].status).toBe('merged');
  });

  it('reports complete once the run branch is already merged into base, with every slice already folded in', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4b', 'main');
    const slice: Slice = {
      id: 'only',
      title: 'Only slice',
      description: 'Do the only thing.',
      order: 0,
      status: 'merged',
      reviewCycles: 0,
      mergeAttempts: 0,
    };
    await writeSlices(paths, [slice]);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: null });
    await checkoutNewBranchAt(repo.dir, runBranchFor('run4b'), 'main');
    await writeFile(`${repo.dir}/impl.txt`, 'x');
    await commitAll(repo.dir, 'implement only');
    await checkoutExistingBranch(repo.dir, 'main');
    await mergeBranchInto(repo.dir, runBranchFor('run4b'), 'main');

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(true);
  });

  it('reports not complete when there is no current slice and no slices exist at all', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4c', 'main');
    await writeSlices(paths, []);

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(false);
  });

  it('reports not complete when the current slice id matches nothing but a slice is still unmerged', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4d', 'main');
    const slices: Slice[] = [
      {
        id: 'done',
        title: 'Done slice',
        description: 'Already folded into the run branch.',
        order: 0,
        status: 'merged',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'not-done',
        title: 'Not done slice',
        description: 'Still pending.',
        order: 1,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ];
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: null });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(false);
  });

  it('advances past an already-merged current slice to the next pending one instead of dead-ending', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run5', 'main');
    const slices: Slice[] = [
      {
        id: 'first',
        title: 'First slice',
        description: 'Already folded into the run branch.',
        order: 0,
        status: 'merged',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'second',
        title: 'Second slice',
        description: 'Still pending.',
        order: 1,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ];
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'first' });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(false);
    const updatedMeta = await readRunMeta(paths);
    expect(updatedMeta.currentSliceId).toBe('second');
  });

  it('picks the next slice by order, not array position, when multiple slices remain', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3e', 'main');
    // Array position deliberately disagrees with `order`: the slice that
    // should come next ('low-order') is listed *after* the one that should
    // come later ('high-order'). Only a real sort by `order` picks correctly.
    const slices: Slice[] = [
      {
        id: 'current',
        title: 'Current',
        description: 'current',
        order: 0,
        status: 'ready_to_merge',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'high-order',
        title: 'High order',
        description: 'high',
        order: 2,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'low-order',
        title: 'Low order',
        description: 'low',
        order: 1,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ];
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'current' });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    const updatedMeta = await readRunMeta(paths);
    expect(updatedMeta.currentSliceId).toBe('low-order');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/orchestrator/reconcile.test.ts`
Expected: FAIL — `src/orchestrator/reconcile.ts` still imports the now-deleted `./advance.js` (Task 2), and its per-slice `ready_to_merge`/`merged` handling still tries to merge each slice's own (nonexistent) branch.

- [ ] **Step 3: Rewrite the reconciler's post-approval handling**

Replace the whole contents of `src/orchestrator/reconcile.ts` with:

```ts
import type { JigConfig } from '../config/load-config.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import type { MergeStrategy } from '../strategies/merge/types.js';
import type { RunPaths } from '../state/run-paths.js';
import type { RunMeta, Slice, SliceStatus } from '../state/types.js';
import { readRunMeta, readSlices, writeRunMeta, writeSlices } from '../state/store.js';
import { finalizeRun } from './finalize-run.js';
import { runImplementStep } from './implement-step.js';
import { runReviewStep } from './review-step.js';

export interface ReconcilePassInput {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
  /** Used for the review step, and for implement when `implementProvider` is unset. */
  provider: AgentProvider;
  /** Overrides `provider` for the implement step only — see `implementProviderCommand`. */
  implementProvider?: AgentProvider;
  config: JigConfig;
  mergeStrategy: MergeStrategy;
}

export interface ReconcilePassResult {
  blocked: boolean;
  reason?: string;
  complete: boolean;
}

export async function runReconcilerPass(input: ReconcilePassInput): Promise<ReconcilePassResult> {
  const { repoRoot, paths, baseBranch, provider, implementProvider, config, mergeStrategy } = input;
  const meta = await readRunMeta(paths);
  const slices = await readSlices(paths);
  const slice = slices.find((candidate) => candidate.id === meta.currentSliceId);

  if (!slice) {
    if (slices.length === 0) return { blocked: false, complete: false };
    if (!slices.every((candidate) => candidate.status === 'merged')) {
      return { blocked: false, complete: false };
    }
    // Every slice has already been folded into the run branch — the only
    // thing left is the one merge of that branch into baseBranch.
    return finalizeRun({ repoRoot, paths, baseBranch, mergeStrategy });
  }

  switch (slice.status) {
    case 'pending':
      await runImplementStep({
        repoRoot,
        paths,
        slice,
        baseBranch,
        provider: implementProvider ?? provider,
        skipCommitSigning: config.commitSigning === 'skip',
      });
      break;
    case 'in_review':
      await runReviewStep({ paths, slice, provider, config });
      if ((slice.status as SliceStatus) === 'ready_to_merge') {
        return advancePastSlice(
          { repoRoot, paths, baseBranch, mergeStrategy },
          slices,
          slice,
          meta,
        );
      }
      break;
    case 'ready_to_merge':
    case 'merged':
      // Routing both through the same helper is what makes this
      // self-healing instead of a dead end: two reachable paths (the
      // slice-planning provider returning zero slices, or duplicate slice
      // ids) can leave currentSliceId pointing at a slice that is already
      // 'merged'.
      return advancePastSlice({ repoRoot, paths, baseBranch, mergeStrategy }, slices, slice, meta);
    case 'stuck':
      await writeSlices(paths, slices);
      return {
        blocked: true,
        reason: `slice "${slice.id}" is stuck — needs human intervention`,
        complete: false,
      };
    case 'implementing':
      break;
  }

  await writeSlices(paths, slices);
  return { blocked: false, complete: false };
}

/**
 * Marks `slice` done — folded into the run's single branch, which already
 * happened when it was committed, so there is nothing to merge per slice —
 * and moves currentSliceId to the next pending slice by order. Once no slice
 * remains, hands off to the one run-level merge in finalizeRun.
 */
async function advancePastSlice(
  input: { repoRoot: string; paths: RunPaths; baseBranch: string; mergeStrategy: MergeStrategy },
  slices: Slice[],
  slice: Slice,
  meta: RunMeta,
): Promise<ReconcilePassResult> {
  const { repoRoot, paths, baseBranch, mergeStrategy } = input;
  slice.status = 'merged';
  await writeSlices(paths, slices);
  const nextSlice = slices
    .filter((candidate) => candidate.status !== 'merged')
    .sort((a, b) => a.order - b.order)[0];
  await writeRunMeta(paths, {
    ...meta,
    currentSliceId: nextSlice?.id ?? null,
    updatedAt: new Date().toISOString(),
  });
  if (nextSlice) return { blocked: false, complete: false };
  return finalizeRun({ repoRoot, paths, baseBranch, mergeStrategy });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/orchestrator/reconcile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/reconcile.ts tests/orchestrator/reconcile.test.ts
git commit -m "sdlc: reconciler folds approved slices into the run branch, merges once at the end"
```

---

## Task 6: Run summary always shows the run branch's commits

**Files:**

- Modify: `src/cli/run-summary.ts`
- Test: `tests/cli/run-summary.test.ts`

**Interfaces:**

- Consumes: `runBranchFor` from Task 1.
- Produces: `printRunSummary` unchanged signature; it no longer needs `currentSliceId` to decide whether to show commits, since the run branch is meaningful even after the last slice is done and only the final merge remains.

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `tests/cli/run-summary.test.ts` with:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { printRunSummary } from '../../src/cli/run-summary.js';
import { checkoutExistingBranch, checkoutNewBranchAt } from '../../src/git/branch.js';
import { commitAll } from '../../src/git/repository.js';
import { initializeRunState } from '../../src/state/store.js';
import { runBranchFor } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
  vi.restoreAllMocks();
});

describe('printRunSummary', () => {
  it('prints the worktree path and the commits the run branch has over the base branch', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    await checkoutNewBranchAt(repo.dir, runBranchFor('run1'), 'main');
    await writeFile(path.join(repo.dir, 'feature.txt'), 'x');
    await commitAll(repo.dir, 'implement the feature');
    await checkoutExistingBranch(repo.dir, 'main');
    await writeFile(path.join(paths.stateDir, 'design.md'), '# Design');
    await writeFile(path.join(paths.stateDir, 'plan.md'), '# Plan');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await printRunSummary({ repoRoot: repo.dir, paths, baseBranch: 'main' });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes(`Worktree: ${paths.workspaceDir}`))).toBe(true);
    expect(
      logged.some((line) => line.startsWith('Design: ') && line.endsWith('state/design.md')),
    ).toBe(true);
    expect(logged.some((line) => line.startsWith('Plan: ') && line.endsWith('state/plan.md'))).toBe(
      true,
    );
    expect(logged.some((line) => line.includes('Commits on run branch'))).toBe(true);
    expect(logged.some((line) => line.includes('implement the feature'))).toBe(true);
  });

  it('prints (none) when the run branch has no commits over the base branch', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run2', 'main');
    await checkoutNewBranchAt(repo.dir, runBranchFor('run2'), 'main');
    await checkoutExistingBranch(repo.dir, 'main');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await printRunSummary({ repoRoot: repo.dir, paths, baseBranch: 'main' });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('Worktree:'))).toBe(true);
    expect(logged.some((line) => line.trim() === '(none)')).toBe(true);
  });

  it('prints (none) when the run branch does not exist yet', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3', 'main');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await printRunSummary({ repoRoot: repo.dir, paths, baseBranch: 'main' });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('Worktree:'))).toBe(true);
    expect(logged.some((line) => line.trim() === '(none)')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/cli/run-summary.test.ts`
Expected: FAIL — `printRunSummary` still looks up `currentSliceId`/`current.branch` and prints "Commits on slice branch".

- [ ] **Step 3: Rewrite `printRunSummary`**

Replace the whole contents of `src/cli/run-summary.ts` with:

```ts
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openRepo } from '../git/repository.js';
import { runBranchFor } from '../state/types.js';
import type { RunPaths } from '../state/run-paths.js';

export interface RunSummaryInput {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
}

/**
 * Prints where the run's code lives (the run's single worktree/branch) and
 * what it has contributed so far (its commits over the base branch), so a
 * blocked or finished run can be picked up without digging through state
 * files.
 */
export async function printRunSummary(input: RunSummaryInput): Promise<void> {
  const { repoRoot, paths, baseBranch } = input;
  console.log(`Worktree: ${paths.workspaceDir}`);
  for (const [label, filename] of [
    ['Design', 'design.md'],
    ['Plan', 'plan.md'],
  ] as const) {
    const docPath = path.join(paths.stateDir, filename);
    if (existsSync(docPath)) console.log(`${label}: ${docPath}`);
  }

  const branch = runBranchFor(paths.runId);
  console.log(`Commits on run branch (not in ${baseBranch}):`);
  let log;
  try {
    log = await openRepo(repoRoot).log([`${baseBranch}..${branch}`]);
  } catch {
    console.log('  (none)');
    return;
  }
  if (log.total === 0) {
    console.log('  (none)');
    return;
  }
  for (const commit of log.all) {
    console.log(`  ${commit.hash.slice(0, 7)} ${commit.message.split('\n')[0]}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/cli/run-summary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/run-summary.ts tests/cli/run-summary.test.ts
git commit -m "sdlc: run summary always shows the run branch's commits, not a per-slice branch"
```

---

## Task 7: One PR description for the whole run

**Files:**

- Modify: `src/strategies/pr/types.ts`
- Modify: `src/strategies/pr/local.ts`
- Modify: `src/cli/commands/create-pr.ts`
- Test: `tests/strategies/pr/local.test.ts`

**Interfaces:**

- Consumes: `readPlan`/`readSlices` from `src/state/store.ts` (unchanged).
- Produces: `PrCreateStrategy.create(paths: RunPaths): Promise<void>` — drops the `slice: Slice` parameter entirely, since there is no longer a single "current" slice worth highlighting once the run's slices all share one branch and one PR.

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `tests/strategies/pr/local.test.ts` with:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalPrCreateStrategy } from '../../../src/strategies/pr/local.js';
import {
  initializeRunState,
  readRunMeta,
  writePlan,
  writeRunMeta,
  writeSlices,
} from '../../../src/state/store.js';
import type { Slice } from '../../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('LocalPrCreateStrategy', () => {
  it('writes a PR description file into the state directory, not the workspace worktree', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    await writePlan(paths, {
      summary: 'Add health route',
      approach: 'Adds GET /health returning 200.',
      affectedAreas: ['src/routes'],
    });
    const slice: Slice = {
      id: 's1',
      title: 'Add health route',
      description: 'Adds GET /health returning 200.',
      order: 0,
      status: 'merged',
      reviewCycles: 0,
      mergeAttempts: 0,
    };
    await writeSlices(paths, [slice]);

    await new LocalPrCreateStrategy().create(paths);

    const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
    expect(content).toContain('Add health route');
    expect(content).toContain('Adds GET /health returning 200.');
  });

  it('embeds the design and plan and checks off every slice already folded into the run branch', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run2', 'main');
    await writePlan(paths, {
      summary: 'Add /health endpoint',
      approach: 'Add a route returning 200 OK',
      affectedAreas: ['src/routes'],
    });
    await writeFile(path.join(paths.stateDir, 'design.md'), '# Design\n\nA route returning 200.');
    await writeFile(path.join(paths.stateDir, 'plan.md'), '# Plan\n\n## Step 1 — Add health route');
    const s1: Slice = {
      id: 's1',
      title: 'Add health route',
      description: 'Implements plan step 1. Adds GET /health returning 200.',
      order: 0,
      status: 'merged',
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
    };
    await writeSlices(paths, [s1, s2]);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 's2' });

    await new LocalPrCreateStrategy().create(paths);

    const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
    expect(content).toContain('## Design');
    expect(content).toContain('A route returning 200.');
    expect(content).toContain('## Plan');
    expect(content).toContain('## Step 1 — Add health route');
    expect(content).toContain('- [x] s1 — Implements plan step 1. Adds GET /health returning 200.');
    expect(content).toContain('- [ ] s2 — Implements plan step 2. Wire the route into the app.');
  });

  it('omits the design and plan markdown sections when the run has no planning docs, using the plan summary as the title', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3', 'main');
    await writePlan(paths, {
      summary: 'Add health route',
      approach: 'Adds GET /health returning 200.',
      affectedAreas: ['src/routes'],
    });
    const slice: Slice = {
      id: 's1',
      title: 'Add health route',
      description: 'Adds GET /health returning 200.',
      order: 0,
      status: 'merged',
      reviewCycles: 0,
      mergeAttempts: 0,
    };
    await writeSlices(paths, [slice]);

    await new LocalPrCreateStrategy().create(paths);

    const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
    expect(content).not.toContain('## Design');
    expect(content).not.toContain('## Plan');
    expect(content).toContain('Add health route');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/strategies/pr/local.test.ts`
Expected: FAIL — `LocalPrCreateStrategy.create` still requires a second `slice` argument and reads `readSlices` with a try/catch fallback keyed on that one slice.

- [ ] **Step 3: Rewrite the PR strategy interface and implementation**

Replace the whole contents of `src/strategies/pr/types.ts` with:

```ts
import type { RunPaths } from '../../state/run-paths.js';

export interface PrCreateStrategy {
  create(paths: RunPaths): Promise<void>;
}
```

Replace the whole contents of `src/strategies/pr/local.ts` with:

```ts
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readPlan, readSlices } from '../../state/store.js';
import type { RunPaths } from '../../state/run-paths.js';
import type { Slice } from '../../state/types.js';
import type { PrCreateStrategy } from './types.js';

export class LocalPrCreateStrategy implements PrCreateStrategy {
  async create(paths: RunPaths): Promise<void> {
    const plan = await readPlan(paths);
    const slices = await readSlices(paths);
    const content = [
      `# ${plan.summary}`,
      '',
      plan.approach,
      '',
      ...(await this.planningSections(paths)),
      this.sliceMapping(slices),
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

  private sliceMapping(slices: Slice[]): string {
    const lines = [...slices]
      .sort((a, b) => a.order - b.order)
      .map(
        (s) => `- [${s.status === 'merged' ? 'x' : ' '}] ${s.id} — ${s.description.split('\n')[0]}`,
      );
    return ['## Slices', '', ...lines].join('\n');
  }
}
```

- [ ] **Step 4: Update the CLI command**

Replace the whole contents of `src/cli/commands/create-pr.ts` with:

```ts
import { Command } from 'commander';
import path from 'node:path';
import { LocalPrCreateStrategy } from '../../strategies/pr/local.js';
import { loadCliRunContext } from '../run-context.js';
import { withErrorHandling } from '../with-error-handling.js';

export function registerCreatePrCommand(program: Command): void {
  program
    .command('create-pr')
    .requiredOption('--run <id>', 'run id')
    .action(
      withErrorHandling(async (opts: { run: string }) => {
        const context = await loadCliRunContext(process.cwd(), opts.run);
        await new LocalPrCreateStrategy().create(context.paths);
        console.log(
          `Wrote PR description to ${path.join(context.paths.stateDir, 'PR_DESCRIPTION.md')}`,
        );
      }),
    );
}
```

- [ ] **Step 5: Update the README's `create-pr` row**

In `README.md`, change:

```
| `jig create-pr --run <id>`     | Writes a local PR description for the current slice (no `gh` integration in v1).                                |
```

to:

```
| `jig create-pr --run <id>`     | Writes a local PR description for the whole run — every slice ships as one PR (no `gh` integration in v1).      |
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/strategies/pr/local.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/strategies/pr/types.ts src/strategies/pr/local.ts src/cli/commands/create-pr.ts tests/strategies/pr/local.test.ts README.md
git commit -m "sdlc: one PR description per run instead of per current slice"
```

---

## Task 8: `jig merge` merges the whole run, once, when every slice is done

**Files:**

- Modify: `src/cli/commands/merge.ts`
- Test: Create `tests/cli/commands/merge.test.ts`

**Interfaces:**

- Consumes: `finalizeRun` from Task 2, `readRunMeta` from `src/state/store.ts` (unchanged).
- Produces: no change to the command's CLI surface (`jig merge --run <id>`), only to what it does internally.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/commands/merge.test.ts` (mirrors the mocking style already used in `tests/cli/commands/step.test.ts`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('../../../src/orchestrator/finalize-run.js', () => ({ finalizeRun: vi.fn() }));
vi.mock('../../../src/cli/run-context.js', () => ({ loadCliRunContext: vi.fn() }));
vi.mock('../../../src/state/store.js', () => ({ readRunMeta: vi.fn() }));

import { registerMergeCommand } from '../../../src/cli/commands/merge.js';
import { finalizeRun } from '../../../src/orchestrator/finalize-run.js';
import { loadCliRunContext } from '../../../src/cli/run-context.js';
import { readRunMeta } from '../../../src/state/store.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const fakeContext = {
  repoRoot: '/tmp/repo',
  paths: {
    runId: 'r1',
    repoRoot: '/tmp/repo',
    stateDir: '/tmp/repo/.jig/r1/state',
    workspaceDir: '/tmp/repo/.jig/r1/workspace',
  },
  baseBranch: 'main',
  config: {
    mergeMode: 'manual' as const,
    reviewCycleCap: 3,
    conflictResolveCap: 3,
    inputSource: 'markdown-file' as const,
    planner: { provider: 'claude' as const },
    implementer: { provider: 'claude' as const },
    reviewer: { provider: 'claude' as const },
  },
  mergeStrategy: { merge: vi.fn() },
};

describe('merge command', () => {
  it('refuses to merge while a slice is still pending or in review', async () => {
    vi.mocked(loadCliRunContext).mockResolvedValue(fakeContext);
    vi.mocked(readRunMeta).mockResolvedValue({
      runId: 'r1',
      baseBranch: 'main',
      currentSliceId: 'still-going',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerMergeCommand(program);
    await program.parseAsync(['node', 'jig', 'merge', '--run', 'r1']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('still has a slice'));
    expect(finalizeRun).not.toHaveBeenCalled();
  });

  it('merges the run branch and reports completion once every slice is done', async () => {
    vi.mocked(loadCliRunContext).mockResolvedValue(fakeContext);
    vi.mocked(readRunMeta).mockResolvedValue({
      runId: 'r1',
      baseBranch: 'main',
      currentSliceId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(finalizeRun).mockResolvedValue({ blocked: false, complete: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerMergeCommand(program);
    await program.parseAsync(['node', 'jig', 'merge', '--run', 'r1']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('complete'));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/cli/commands/merge.test.ts`
Expected: FAIL — `src/cli/commands/merge.ts` still imports `advanceRun` from the deleted `../../orchestrator/advance.js` and doesn't guard on `currentSliceId`.

- [ ] **Step 3: Rewrite the merge command**

Replace the whole contents of `src/cli/commands/merge.ts` with:

```ts
import { Command } from 'commander';
import { finalizeRun } from '../../orchestrator/finalize-run.js';
import { AutoMergeStrategy } from '../../strategies/merge/auto.js';
import { readRunMeta } from '../../state/store.js';
import { loadCliRunContext } from '../run-context.js';
import { withErrorHandling } from '../with-error-handling.js';

export function registerMergeCommand(program: Command): void {
  program
    .command('merge')
    .requiredOption('--run <id>', 'run id')
    .action(
      withErrorHandling(async (opts: { run: string }) => {
        const context = await loadCliRunContext(process.cwd(), opts.run);
        const meta = await readRunMeta(context.paths);
        if (meta.currentSliceId !== null) {
          console.log('Nothing to merge yet — the run still has a slice pending or in review.');
          return;
        }
        // Deliberately a fresh AutoMergeStrategy(), not context.mergeStrategy:
        // an explicit `jig merge` invocation IS the human's decision to
        // merge now, regardless of the configured mergeMode. Under manual
        // mode, context.mergeStrategy would be a no-op ManualMergeStrategy,
        // which would make this command do nothing.
        const result = await finalizeRun({ ...context, mergeStrategy: new AutoMergeStrategy() });
        console.log(
          result.complete ? `Merged. Run "${opts.run}" complete.` : 'Nothing to merge yet.',
        );
      }),
    );
}
```

- [ ] **Step 4: Update the README's `mergeMode` and `merge` rows**

In `README.md`, change:

```
| `mergeMode`                | `"manual"`        | `"manual"`: the tool never merges a slice into your base branch itself — only detects that you did. `"auto"`: the tool merges automatically once a slice is approved. |
```

to:

```
| `mergeMode`                | `"manual"`        | `"manual"`: the tool never merges the run's branch into your base branch itself — only detects that you did. `"auto"`: the tool merges automatically once every slice is approved. |
```

And change:

```
| `jig merge --run <id>`         | Manually merges an approved slice now, regardless of `mergeMode`.                                               |
```

to:

```
| `jig merge --run <id>`         | Manually merges the run's branch (every slice's commits, as one unit) now, once every slice is approved — regardless of `mergeMode`. |
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/cli/commands/merge.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/merge.ts tests/cli/commands/merge.test.ts README.md
git commit -m "sdlc: merge command merges the whole run once every slice is approved"
```

---

## Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, including `tests/orchestrator/end-to-end.test.ts` unchanged — its fixture never referenced `slice.branch` (branch names were always derived inside `prepare.ts`/`implement-step.ts`, never part of the mocked provider output), so it should already be green from Task 5 onward. If it fails, the mismatch is almost certainly the `slices[0].status` assertion at the end (`'merged'`) — confirm it still reads `'merged'`, since that's unchanged: a single-slice run still ends with the one slice `merged` and the run `complete`.

- [ ] **Step 2: Type-check and lint**

Run: `npm run build`
Expected: PASS — no leftover references to `Slice.branch`, `advanceRun`, or the old two-argument `PrCreateStrategy.create`.

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Confirm no stray references remain**

Run: `grep -rn "jig/slice/\|advanceRun\|\.branch\b" src tests --include="*.ts"`
Expected: no output. (`src/git/branch.ts`'s own `openRepo(cwd).branch([...])` call is a `simple-git` API method, not `Slice.branch` — if this grep flags it, that's a false positive to leave alone; everything else should be gone.)

- [ ] **Step 4: Commit if anything was left uncommitted**

```bash
git status
```

If clean, this task needs no commit. If anything is outstanding from a prior task's step, commit it now with a message describing what was missed.
