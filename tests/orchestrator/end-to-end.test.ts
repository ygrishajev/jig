import { afterEach, describe, expect, it } from 'vitest';
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
        case 3: // prepareRun: slice-plan step
          await writeFile(
            structuredOutputPath(input.cwd),
            JSON.stringify([
              {
                id: 'add-health-route',
                title: 'Add health route',
                description: 'Add GET /health',
              },
            ]),
          );
          break;
        case 4: // reconciler pass 1: implement step (cwd = workspace worktree)
          await writeFile(path.join(input.cwd, 'health.txt'), 'ok');
          break;
        case 5: // reconciler pass 2: review step (cwd = workspace worktree)
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
    expect(call).toBe(5);
  });
});
