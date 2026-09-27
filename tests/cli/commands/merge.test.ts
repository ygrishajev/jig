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
    stateDir: '/tmp/repo/.sdlc/r1/state',
    workspaceDir: '/tmp/repo/.sdlc/r1/workspace',
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
    await program.parseAsync(['node', 'sdlc', 'merge', '--run', 'r1']);

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
    await program.parseAsync(['node', 'sdlc', 'merge', '--run', 'r1']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('complete'));
  });
});
