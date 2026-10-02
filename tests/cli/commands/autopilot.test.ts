import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

vi.mock('../../../src/orchestrator/reconcile.js', () => ({ runReconcilerPass: vi.fn() }));
vi.mock('../../../src/orchestrator/prepare.js', () => ({ prepareRun: vi.fn() }));
vi.mock('../../../src/cli/run-context.js', () => ({
  loadCliRunContext: vi.fn(),
  selectProvider: vi.fn(),
}));
vi.mock('../../../src/config/load-config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../../src/strategies/input-source/markdown-file.js', () => ({
  MarkdownFileInputSource: vi.fn(),
}));

import { runAutopilot, registerAutopilotCommands } from '../../../src/cli/commands/autopilot.js';
import { runReconcilerPass } from '../../../src/orchestrator/reconcile.js';
import { prepareRun } from '../../../src/orchestrator/prepare.js';
import { loadConfig } from '../../../src/config/load-config.js';
import { loadCliRunContext, selectProvider } from '../../../src/cli/run-context.js';
import { readRunResult } from '../../../src/state/store.js';

let repoDir: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
  repoDir = undefined;
});

describe('runAutopilot', () => {
  it('loops the reconciler pass until complete', async () => {
    vi.mocked(runReconcilerPass)
      .mockResolvedValueOnce({ blocked: false, complete: false })
      .mockResolvedValueOnce({ blocked: false, complete: false })
      .mockResolvedValueOnce({ blocked: false, complete: true });

    const result = await runAutopilot({
      repoRoot: '/tmp/repo',
      paths: { runId: 'r1', repoRoot: '/tmp/repo', stateDir: '/x', workspaceDir: '/y' },
      baseBranch: 'main',
      provider: { run: vi.fn() },
      config: {
        mergeMode: 'auto',
        reviewCycleCap: 3,
        conflictResolveCap: 3,
        inputSource: 'markdown-file',
        planner: { provider: 'claude' },
        implementer: { provider: 'claude' },
        reviewer: { provider: 'claude' },
      },
      mergeStrategy: { merge: vi.fn() },
    });

    expect(result.complete).toBe(true);
    expect(result.passes).toBe(3);
  });

  it('stops and reports the reason when a pass is blocked', async () => {
    vi.mocked(runReconcilerPass).mockResolvedValueOnce({
      blocked: true,
      reason: 'slice "s1" is stuck — needs human intervention',
      complete: false,
    });

    const result = await runAutopilot({
      repoRoot: '/tmp/repo',
      paths: { runId: 'r1', repoRoot: '/tmp/repo', stateDir: '/x', workspaceDir: '/y' },
      baseBranch: 'main',
      provider: { run: vi.fn() },
      config: {
        mergeMode: 'auto',
        reviewCycleCap: 3,
        conflictResolveCap: 3,
        inputSource: 'markdown-file',
        planner: { provider: 'claude' },
        implementer: { provider: 'claude' },
        reviewer: { provider: 'claude' },
      },
      mergeStrategy: { merge: vi.fn() },
    });

    expect(result.complete).toBe(false);
    expect(result.blockedReason).toContain('stuck');
    expect(result.passes).toBe(1);
  });

  it('throws instead of looping forever if the reconciler never completes or blocks', async () => {
    vi.mocked(runReconcilerPass).mockResolvedValue({ blocked: false, complete: false });

    await expect(
      runAutopilot({
        repoRoot: '/tmp/repo',
        paths: { runId: 'r1', repoRoot: '/tmp/repo', stateDir: '/x', workspaceDir: '/y' },
        baseBranch: 'main',
        provider: { run: vi.fn() },
        config: {
          mergeMode: 'auto',
          reviewCycleCap: 3,
          conflictResolveCap: 3,
          inputSource: 'markdown-file',
          planner: { provider: 'claude' },
          implementer: { provider: 'claude' },
          reviewer: { provider: 'claude' },
        },
        mergeStrategy: { merge: vi.fn() },
      }),
    ).rejects.toThrow(/reconciler passes/);
    // Pins the exact cap (500): a `<=` off-by-one would run 501 passes here.
    expect(vi.mocked(runReconcilerPass).mock.calls.length).toBe(500);
  });
});

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
    vi.mocked(loadConfig).mockReturnValue(config);
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
        stateDir: '/tmp/repo/.sdlc/r1/state',
        workspaceDir: '/tmp/repo/.sdlc/r1/workspace',
      },
      baseBranch: 'main',
      config,
      mergeStrategy: { merge: vi.fn() },
    });
    vi.mocked(selectProvider).mockReturnValue({ run: vi.fn() });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerAutopilotCommands(program);
    await program.parseAsync(['node', 'sdlc', 'autopilot', '--input', 'request.md']);

    expect(vi.mocked(runReconcilerPass)).not.toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('design.md'))).toBe(true);
    expect(logged.some((line) => line.includes('sdlc resume --run r1'))).toBe(true);
  });
});

describe('autopilot command result reporting', () => {
  it('writes a structured result file alongside the human-readable summary once a run blocks', async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'sdlc-autopilot-cli-'));
    const config = {
      mergeMode: 'manual' as const,
      reviewCycleCap: 3,
      conflictResolveCap: 3,
      inputSource: 'markdown-file' as const,
      planner: { provider: 'claude' as const },
      implementer: { provider: 'claude' as const },
      reviewer: { provider: 'claude' as const },
      commitSigning: 'repo' as const,
    };
    const paths = {
      runId: 'r2',
      repoRoot: repoDir,
      stateDir: path.join(repoDir, '.sdlc', 'r2', 'state'),
      workspaceDir: path.join(repoDir, '.sdlc', 'r2', 'workspace'),
    };
    vi.mocked(loadConfig).mockReturnValue(config);
    vi.mocked(prepareRun).mockResolvedValue({
      runId: 'r2',
      baseBranch: 'main',
      currentSliceId: 's1',
      createdAt: '',
      updatedAt: '',
    });
    vi.mocked(loadCliRunContext).mockResolvedValue({
      repoRoot: repoDir,
      paths,
      baseBranch: 'main',
      config,
      mergeStrategy: { merge: vi.fn() },
    });
    vi.mocked(selectProvider).mockReturnValue({ run: vi.fn() });
    vi.mocked(runReconcilerPass).mockResolvedValueOnce({
      blocked: true,
      reason: 'run branch "sdlc/run/r2" is not yet merged into "main"',
      complete: false,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerAutopilotCommands(program);
    await program.parseAsync(['node', 'sdlc', 'autopilot', '--input', 'request.md']);

    expect(await readRunResult(paths)).toEqual({
      runId: 'r2',
      complete: false,
      blockedReason: 'run branch "sdlc/run/r2" is not yet merged into "main"',
      passes: 1,
    });
  });
});
