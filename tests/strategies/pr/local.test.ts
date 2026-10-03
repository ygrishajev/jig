import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FakeAgentProvider } from '../../../src/strategies/provider/fake.js';
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
    expect(content).toContain('<summary>Design</summary>');
    expect(content).toContain('A route returning 200.');
    expect(content).toContain('<summary>Plan</summary>');
    expect(content).toContain('## Step 1 — Add health route');
    expect(content).toContain('- [x] s1 — Implements plan step 1. Adds GET /health returning 200.');
    expect(content).toContain('- [ ] s2 — Implements plan step 2. Wire the route into the app.');
  });

  it("includes a stuck slice's reviewer feedback, so a PR opened for a blocked run still shows why", async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4', 'main');
    await writePlan(paths, {
      summary: 'Add /health endpoint',
      approach: 'Add a route returning 200 OK',
      affectedAreas: ['src/routes'],
    });
    const stuck: Slice = {
      id: 's1',
      title: 'Add health route',
      description: 'Implements plan step 1. Adds GET /health returning 200.',
      order: 0,
      status: 'stuck',
      reviewCycles: 3,
      mergeAttempts: 0,
      lastFeedback: 'Missing a test for the 500 path.',
    };
    await writeSlices(paths, [stuck]);

    await new LocalPrCreateStrategy().create(paths);

    const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
    expect(content).toContain('- [ ] s1 — Implements plan step 1. Adds GET /health returning 200.');
    expect(content).toContain('[stuck]');
    expect(content).toContain('Missing a test for the 500 path.');
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
    expect(content).not.toContain('<summary>Design</summary>');
    expect(content).not.toContain('<summary>Plan</summary>');
    expect(content).toContain('Add health route');
  });

  it("uses the repository's pull request template and tucks the agent run into a collapsed section", async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run5', 'main');
    await mkdir(path.join(repo.dir, '.github'), { recursive: true });
    await writeFile(
      path.join(repo.dir, '.github', 'pull_request_template.md'),
      '## What\n\n## Why\n',
    );
    await writePlan(paths, {
      summary: 'Add health route',
      approach: 'Adds GET /health returning 200.',
      affectedAreas: ['src/routes'],
    });
    await writeSlices(paths, []);

    await new LocalPrCreateStrategy().create(paths);

    const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
    expect(content.startsWith('## What\n\n## Why')).toBe(true);
    expect(content).toContain('<summary>Agent run</summary>');
    expect(content).toContain('Adds GET /health returning 200.');
    expect(content).not.toContain('## Summary');
  });

  it('falls back to a readable default layout when the repository has no template', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run6', 'main');
    await writePlan(paths, {
      summary: 'Add health route',
      approach: 'Adds GET /health returning 200.',
      affectedAreas: ['src/routes'],
    });
    await writeSlices(paths, []);

    await new LocalPrCreateStrategy().create(paths);

    const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
    expect(content).toContain('## Summary\n\nAdd health route');
    expect(content).toContain('## Approach');
    expect(content).not.toContain('<summary>Agent run</summary>');
  });

  describe('with a describer agent', () => {
    async function preparedRun(runId: string) {
      repo = await createTempRepo();
      const paths = await initializeRunState(repo.dir, runId, 'main');
      await writePlan(paths, {
        summary: 'Add health route',
        approach: 'Adds GET /health returning 200.',
        affectedAreas: ['src/routes'],
      });
      await writeSlices(paths, []);
      await mkdir(paths.workspaceDir, { recursive: true });
      return paths;
    }

    it("hands the agent the repository's template and appends the agent run after its filled-in body", async () => {
      const paths = await preparedRun('run7');
      await mkdir(path.join(repo.dir, '.github'), { recursive: true });
      await writeFile(
        path.join(repo.dir, '.github', 'pull_request_template.md'),
        '## What\n\n## Why\n',
      );
      let seenPrompt = '';
      const provider = new FakeAgentProvider(async ({ cwd, prompt }) => {
        seenPrompt = prompt;
        await writeFile(
          path.join(cwd, '.sdlc-step-output.json'),
          JSON.stringify({ body: '## What\n\nA health check.\n\n## Why\n\nMonitoring.' }),
        );
        return { success: true, output: '' };
      });

      await new LocalPrCreateStrategy({ provider }).create(paths);

      const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
      expect(seenPrompt).toContain('## What\n\n## Why');
      expect(content.startsWith('## What\n\nA health check.')).toBe(true);
      expect(content).toContain('<summary>Agent run</summary>');
    });

    it('offers the default template when the repository has none', async () => {
      const paths = await preparedRun('run8');
      let seenPrompt = '';
      const provider = new FakeAgentProvider(async ({ cwd, prompt }) => {
        seenPrompt = prompt;
        await writeFile(path.join(cwd, '.sdlc-step-output.json'), JSON.stringify({ body: 'ok' }));
        return { success: true, output: '' };
      });

      await new LocalPrCreateStrategy({ provider }).create(paths);

      expect(seenPrompt).toContain('## Deletions and deviations');
    });

    it('falls back to the plain layout when the agent fails or writes no valid output', async () => {
      const paths = await preparedRun('run9');
      const provider = new FakeAgentProvider(() => ({ success: true, output: '' }));

      await new LocalPrCreateStrategy({ provider }).create(paths);

      const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
      expect(content).toContain('## Summary\n\nAdd health route');
    });
  });
});
