import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareRun } from '../../src/orchestrator/prepare.js';
import { MarkdownFileInputSource } from '../../src/strategies/input-source/markdown-file.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { structuredOutputPath } from '../../src/orchestrator/structured-output.js';
import { loadRunState, readContext, readPlan, readSlices } from '../../src/state/store.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('prepareRun', () => {
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
        const stateDir = path.join(repo.dir, '.sdlc', await currentRunId(repo.dir), 'state');
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

    const stateDir = path.join(repo.dir, '.sdlc', meta.runId, 'state');
    expect(existsSync(path.join(stateDir, 'design.md'))).toBe(true);
    expect(existsSync(path.join(stateDir, 'plan.md'))).toBe(true);
    expect(slicePrompt).toContain('## Step 1 — Add health route');
    const slices = await readSlices(await loadRunState(repo.dir, meta.runId));
    expect(slices[0].description).toContain('Implements plan step 1');
  });

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

  it('logs the run id and each planning stage as it goes', async () => {
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
              ? await writePlanningDocs(input.cwd)
              : [
                  {
                    id: 'add-health-route',
                    title: 'Add health route',
                    description: 'Add GET /health',
                  },
                ];
      await writeFile(structuredOutputPath(input.cwd), JSON.stringify(output));
      return { success: true, output: 'done' };
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const meta = await prepareRun({
      repoRoot: repo.dir,
      inputSource: new MarkdownFileInputSource(requestPath),
      provider,
    });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    const runLines = logged.filter((line) => line.includes(`[sdlc ${meta.runId}]`));
    expect(runLines.some((line) => line.includes('context'))).toBe(true);
    expect(runLines.some((line) => line.includes('feature plan'))).toBe(true);
    expect(runLines.some((line) => line.includes('slice planning'))).toBe(true);
    expect(runLines.some((line) => line.includes('planned 1 slice'))).toBe(true);
  });

  it('runs context, plan, and slice-plan steps and persists the result', async () => {
    repo = await createTempRepo();
    const requestPath = path.join(repo.dir, 'request.md');
    await writeFile(requestPath, '# Add a health check endpoint');

    let call = 0;
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
        await writePlanningDocs(input.cwd);
      } else {
        await writeFile(
          structuredOutputPath(input.cwd),
          JSON.stringify([
            { id: 'add-health-route', title: 'Add health route', description: 'Add GET /health' },
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

    expect(meta.baseBranch).toBe('main');
    expect(meta.currentSliceId).toBe('add-health-route');
    const paths = await loadRunState(repo.dir, meta.runId);
    const context = await readContext(paths);
    expect(context.classification).toBe('feature');
    const plan = await readPlan(paths);
    expect(plan.summary).toContain('/health');
    const slices = await readSlices(paths);
    expect(slices).toHaveLength(1);
    expect(slices[0].status).toBe('pending');
  });

  it('runs the planning steps with the real repository as cwd, not an empty scratch directory', async () => {
    repo = await createTempRepo();
    const requestPath = path.join(repo.dir, 'request.md');
    await writeFile(requestPath, '# Add a health check endpoint');

    const seenCwds: string[] = [];
    let call = 0;
    const provider = new FakeAgentProvider(async (input) => {
      seenCwds.push(input.cwd);
      call += 1;
      const output =
        call === 1
          ? { classification: 'feature', repoSummary: 'An Express app.' }
          : call === 2
            ? { summary: 'Add /health endpoint', approach: 'Add a route', affectedAreas: ['src'] }
            : call === 3
              ? await writePlanningDocs(input.cwd)
              : [
                  {
                    id: 'add-health-route',
                    title: 'Add health route',
                    description: 'Add GET /health',
                  },
                ];
      await writeFile(structuredOutputPath(input.cwd), JSON.stringify(output));
      return { success: true, output: 'done' };
    });

    await prepareRun({
      repoRoot: repo.dir,
      inputSource: new MarkdownFileInputSource(requestPath),
      provider,
    });

    expect(seenCwds).toEqual([repo.dir, repo.dir, repo.dir, repo.dir]);
  });

  it('throws a clear error and does not persist run state when the context step fails', async () => {
    repo = await createTempRepo();
    const requestPath = path.join(repo.dir, 'request.md');
    await writeFile(requestPath, '# Add a health check endpoint');
    const provider = new FakeAgentProvider(async () => ({ success: false, output: 'boom' }));

    await expect(
      prepareRun({
        repoRoot: repo.dir,
        inputSource: new MarkdownFileInputSource(requestPath),
        provider,
      }),
    ).rejects.toThrow(/Context step failed.*boom/s);
  });

  it('leaves no structured-output file behind in the repo root once done', async () => {
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
              ? await writePlanningDocs(input.cwd)
              : [
                  {
                    id: 'add-health-route',
                    title: 'Add health route',
                    description: 'Add GET /health',
                  },
                ];
      await writeFile(structuredOutputPath(input.cwd), JSON.stringify(output));
      return { success: true, output: 'done' };
    });

    await prepareRun({
      repoRoot: repo.dir,
      inputSource: new MarkdownFileInputSource(requestPath),
      provider,
    });

    expect(existsSync(structuredOutputPath(repo.dir))).toBe(false);
  });

  it('throws a clear error when the slice-plan step returns zero slices', async () => {
    // Regression for Important 3: an empty slice list used to silently
    // produce currentSliceId: null, which made runAutopilot spin for 500
    // passes before throwing a misleading "bug in the reconciler" error.
    // sliceOutputSchema's .min(1) now fails loudly right here instead.
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
              ? await writePlanningDocs(input.cwd)
              : [];
      await writeFile(structuredOutputPath(input.cwd), JSON.stringify(output));
      return { success: true, output: 'done' };
    });

    await expect(
      prepareRun({
        repoRoot: repo.dir,
        inputSource: new MarkdownFileInputSource(requestPath),
        provider,
      }),
    ).rejects.toThrow();
  });

  it('throws a clear error naming the duplicate id when the slice-plan step returns duplicate ids', async () => {
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
              ? await writePlanningDocs(input.cwd)
              : [
                  {
                    id: 'add-health-route',
                    title: 'Add health route',
                    description: 'Add GET /health',
                  },
                  {
                    id: 'add-health-route',
                    title: 'Duplicate slice',
                    description: 'Same id as the first slice.',
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
    ).rejects.toThrow(/duplicate slice id.*add-health-route/is);
  });

  it('throws when the slice-plan step returns an id with characters unsafe for a stable slice id', async () => {
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
              ? await writePlanningDocs(input.cwd)
              : [
                  {
                    id: 'Add Health Route!',
                    title: 'Add health route',
                    description: 'Add GET /health',
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
    ).rejects.toThrow();
  });
});

async function currentRunId(repoDir: string): Promise<string> {
  const entries = await readdir(path.join(repoDir, '.sdlc'), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory())[0].name;
}

async function writePlanningDocs(cwd: string): Promise<{ written: string[] }> {
  const stateDir = path.join(repo.dir, '.sdlc', await currentRunId(repo.dir), 'state');
  await writeFile(
    path.join(stateDir, 'design.md'),
    '# Design\n\n## Chosen approach\n\nA route returning 200 OK.',
  );
  await writeFile(path.join(stateDir, 'plan.md'), '# Plan\n\n## Step 1 — Add health route\n');
  await writeFile(structuredOutputPath(cwd), JSON.stringify({ written: ['design.md', 'plan.md'] }));
  return { written: ['design.md', 'plan.md'] };
}
