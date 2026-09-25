import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/orchestrator/reconcile.js', () => ({ runReconcilerPass: vi.fn() }));

import { runAutopilot } from '../../../src/cli/commands/autopilot.js';
import { runReconcilerPass } from '../../../src/orchestrator/reconcile.js';

afterEach(() => {
  vi.restoreAllMocks();
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
        providerCommand: 'claude',
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
        providerCommand: 'claude',
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
          providerCommand: 'claude',
        },
        mergeStrategy: { merge: vi.fn() },
      }),
    ).rejects.toThrow(/reconciler passes/);
  });
});
