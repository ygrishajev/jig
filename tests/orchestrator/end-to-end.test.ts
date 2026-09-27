import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareRun } from '../../src/orchestrator/prepare.js';
import { runAutopilot } from '../../src/cli/commands/autopilot.js';
import { MarkdownFileInputSource } from '../../src/strategies/input-source/markdown-file.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { AutoMergeStrategy } from '../../src/strategies/merge/auto.js';
import { structuredOutputPath } from '../../src/orchestrator/structured-output.js';
import { loadRunState, readSlices } from '../../src/state/store.js';
import type { SdlcConfig } from '../../src/config/load-config.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;
let requestDir: string;

afterEach(async () => {
  await repo?.cleanup();
  if (requestDir) await rm(requestDir, { recursive: true, force: true });
});

// The per-task reviews all tested prepare, the reconciler, advance, and each
// step in isolation — nothing exercised the handoff between prepareRun and
// the reconciler loop for a full run. That gap is exactly what let Important
// finding 3 (a stuck-at-"merged" dead end) go uncaught: no test ever drove a
// run from a fresh request all the way to completion. This test closes that
// gap with a real temp git repo end to end: prepareRun -> implement -> review
// (approve) -> merge (auto mode) -> complete.
describe('end-to-end run', () => {
  it('drives a fresh request through prepare and the reconciler loop to a complete, fully-merged run', async () => {
    repo = await createTempRepo();
    // Deliberately outside repo.dir: prepareRun (unlike this suite's other
    // tests) is driven all the way through a real `sdlc merge`, which refuses
    // to run unless repoRoot's working tree is clean — an untracked
    // request.md sitting inside the repo would make it dirty for reasons
    // unrelated to what this test actually exercises.
    requestDir = await mkdtemp(path.join(tmpdir(), 'sdlc-e2e-request-'));
    const requestPath = path.join(requestDir, 'request.md');
    await writeFile(requestPath, '# Add a health check endpoint');

    let call = 0;
    const provider = new FakeAgentProvider(async (input) => {
      call += 1;
      switch (call) {
        case 1: // prepareRun: context step
          await writeFile(
            structuredOutputPath(input.cwd),
            JSON.stringify({ classification: 'feature', repoSummary: 'An Express app.' }),
          );
          break;
        case 2: // prepareRun: feature-plan step
          await writeFile(
            structuredOutputPath(input.cwd),
            JSON.stringify({
              summary: 'Add /health endpoint',
              approach: 'Add a route returning 200 OK',
              affectedAreas: ['src/routes'],
            }),
          );
          break;
        case 3: {
          // prepareRun: design step — writes the planning docs into this
          // run's state dir, then acks via the structured-output file.
          const { readdir } = await import('node:fs/promises');
          const runDirs = (
            await readdir(path.join(repo.dir, '.sdlc'), { withFileTypes: true })
          ).filter((entry) => entry.isDirectory());
          const stateDir = path.join(repo.dir, '.sdlc', runDirs[0].name, 'state');
          await writeFile(
            path.join(stateDir, 'design.md'),
            '# Design\n\n## Chosen approach\n\nA route returning 200 OK.',
          );
          await writeFile(
            path.join(stateDir, 'plan.md'),
            '# Plan\n\n## Step 1 — Add health route\n',
          );
          await writeFile(
            structuredOutputPath(input.cwd),
            JSON.stringify({ written: ['design.md', 'plan.md'] }),
          );
          break;
        }
        case 4: // prepareRun: slice-plan step
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
          break;
        case 5: // reconciler pass 1: implement step (cwd = workspace worktree)
          await writeFile(path.join(input.cwd, 'health.txt'), 'ok');
          break;
        case 6: // reconciler pass 2: review step (cwd = workspace worktree)
          await writeFile(
            structuredOutputPath(input.cwd),
            JSON.stringify({ approved: true, feedback: '' }),
          );
          break;
        default:
          throw new Error(`unexpected provider call #${call} with cwd ${input.cwd}`);
      }
      return { success: true, output: 'ok' };
    });

    const meta = await prepareRun({
      repoRoot: repo.dir,
      inputSource: new MarkdownFileInputSource(requestPath),
      provider,
    });
    const paths = await loadRunState(repo.dir, meta.runId);
    const config: SdlcConfig = {
      mergeMode: 'auto',
      reviewCycleCap: 3,
      conflictResolveCap: 3,
      inputSource: 'markdown-file',
      planner: { provider: 'claude' },
      implementer: { provider: 'claude' },
      reviewer: { provider: 'claude' },
    };

    const result = await runAutopilot({
      repoRoot: repo.dir,
      paths,
      baseBranch: meta.baseBranch,
      provider,
      config,
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.complete).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    const slices = await readSlices(paths);
    expect(slices).toHaveLength(1);
    expect(slices[0].status).toBe('merged');
    expect(call).toBe(6);
  });

  it('stacks two slices onto one run branch and merges both in a single merge once the run completes', async () => {
    repo = await createTempRepo();
    requestDir = await mkdtemp(path.join(tmpdir(), 'sdlc-e2e-request-'));
    const requestPath = path.join(requestDir, 'request.md');
    await writeFile(requestPath, '# Add a health check endpoint and a readiness endpoint');

    let call = 0;
    const provider = new FakeAgentProvider(async (input) => {
      call += 1;
      switch (call) {
        case 1: // prepareRun: context step
          await writeFile(
            structuredOutputPath(input.cwd),
            JSON.stringify({ classification: 'feature', repoSummary: 'An Express app.' }),
          );
          break;
        case 2: // prepareRun: feature-plan step
          await writeFile(
            structuredOutputPath(input.cwd),
            JSON.stringify({
              summary: 'Add health and readiness endpoints',
              approach: 'Add two routes returning 200 OK',
              affectedAreas: ['src/routes'],
            }),
          );
          break;
        case 3: {
          const { readdir } = await import('node:fs/promises');
          const runDirs = (
            await readdir(path.join(repo.dir, '.sdlc'), { withFileTypes: true })
          ).filter((entry) => entry.isDirectory());
          const stateDir = path.join(repo.dir, '.sdlc', runDirs[0].name, 'state');
          await writeFile(
            path.join(stateDir, 'design.md'),
            '# Design\n\n## Chosen approach\n\nTwo routes returning 200 OK.',
          );
          await writeFile(
            path.join(stateDir, 'plan.md'),
            '# Plan\n\n## Step 1 — Add health route\n\n## Step 2 — Add readiness route\n',
          );
          await writeFile(
            structuredOutputPath(input.cwd),
            JSON.stringify({ written: ['design.md', 'plan.md'] }),
          );
          break;
        }
        case 4: // prepareRun: slice-plan step — two slices this time
          await writeFile(
            structuredOutputPath(input.cwd),
            JSON.stringify([
              {
                id: 'add-health-route',
                title: 'Add health route',
                description: 'Implements plan step 1. Add GET /health',
              },
              {
                id: 'add-readiness-route',
                title: 'Add readiness route',
                description: 'Implements plan step 2. Add GET /ready',
              },
            ]),
          );
          break;
        case 5: // reconciler pass 1: implement slice 1 (cwd = the shared run-branch workspace)
          await writeFile(path.join(input.cwd, 'health.txt'), 'ok');
          break;
        case 6: // reconciler pass 2: review slice 1 (approve)
          await writeFile(
            structuredOutputPath(input.cwd),
            JSON.stringify({ approved: true, feedback: '' }),
          );
          break;
        case 7: // reconciler pass 3: implement slice 2 — same shared workspace/branch as slice 1
          await writeFile(path.join(input.cwd, 'ready.txt'), 'ok');
          break;
        case 8: // reconciler pass 4: review slice 2 (approve) — the last slice, so this pass
          // also triggers the one and only run-level merge
          await writeFile(
            structuredOutputPath(input.cwd),
            JSON.stringify({ approved: true, feedback: '' }),
          );
          break;
        default:
          throw new Error(`unexpected provider call #${call} with cwd ${input.cwd}`);
      }
      return { success: true, output: 'ok' };
    });

    const meta = await prepareRun({
      repoRoot: repo.dir,
      inputSource: new MarkdownFileInputSource(requestPath),
      provider,
    });
    const paths = await loadRunState(repo.dir, meta.runId);
    const config: SdlcConfig = {
      mergeMode: 'auto',
      reviewCycleCap: 3,
      conflictResolveCap: 3,
      inputSource: 'markdown-file',
      planner: { provider: 'claude' },
      implementer: { provider: 'claude' },
      reviewer: { provider: 'claude' },
    };

    const result = await runAutopilot({
      repoRoot: repo.dir,
      paths,
      baseBranch: meta.baseBranch,
      provider,
      config,
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.complete).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    const slices = await readSlices(paths);
    expect(slices).toHaveLength(2);
    expect(slices.every((s) => s.status === 'merged')).toBe(true);
    expect(call).toBe(8);

    // Both slices' files must exist on the base branch after the single
    // merge — proving they were stacked on one run branch and both landed,
    // not just the last one.
    expect(existsSync(path.join(repo.dir, 'health.txt'))).toBe(true);
    expect(existsSync(path.join(repo.dir, 'ready.txt'))).toBe(true);

    // The run branch's commits are now fully reachable from main — the
    // postcondition finalizeRun's single merge call establishes, checked
    // directly rather than assuming a particular merge-commit shape (the
    // merge may fast-forward, which is fine and expected here).
    const { isBranchMergedInto } = await import('../../src/git/merge.js');
    const { runBranchFor } = await import('../../src/state/types.js');
    expect(await isBranchMergedInto(repo.dir, runBranchFor(meta.runId), meta.baseBranch)).toBe(
      true,
    );
  });
});
