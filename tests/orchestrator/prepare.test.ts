import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
    expect(slices[0].branch).toBe(`sdlc/slice/${meta.runId}/add-health-route`);
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

    expect(seenCwds).toEqual([repo.dir, repo.dir, repo.dir]);
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

  it('throws when the slice-plan step returns an id with characters unsafe for a git branch name', async () => {
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
