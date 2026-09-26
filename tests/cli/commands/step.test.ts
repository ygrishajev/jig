import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// vi.mock calls are hoisted above imports by Vitest, so declaring them first
// is a style choice, not a requirement — but spying on named ESM exports
// directly (vi.spyOn(moduleNamespace, 'fn')) does NOT work reliably against
// compiled ESM output: the module under test's own import binding does not
// see the spy. vi.mock with a factory replaces the module in the resolver
// itself, which every importer (including step.ts) sees.
vi.mock('../../../src/orchestrator/reconcile.js', () => ({ runReconcilerPass: vi.fn() }));
vi.mock('../../../src/cli/run-context.js', () => ({
  loadCliRunContext: vi.fn(),
  selectProvider: vi.fn(),
  selectImplementProvider: vi.fn(),
}));

import { registerStepCommands } from '../../../src/cli/commands/step.js';
import { runReconcilerPass } from '../../../src/orchestrator/reconcile.js';
import {
  loadCliRunContext,
  selectImplementProvider,
  selectProvider,
} from '../../../src/cli/run-context.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('implement/review commands', () => {
  it('prints the blocked reason when the reconciler pass is blocked', async () => {
    vi.mocked(loadCliRunContext).mockResolvedValue({
      repoRoot: '/tmp/repo',
      paths: {
        runId: 'r1',
        repoRoot: '/tmp/repo',
        stateDir: '/tmp/repo/.sdlc/r1/state',
        workspaceDir: '/tmp/repo/.sdlc/r1/workspace',
      },
      baseBranch: 'main',
      config: {
        mergeMode: 'manual',
        reviewCycleCap: 3,
        conflictResolveCap: 3,
        inputSource: 'markdown-file',
        providerCommand: 'claude',
      },
      mergeStrategy: { merge: vi.fn() },
    });
    vi.mocked(selectProvider).mockReturnValue({ run: vi.fn() });
    vi.mocked(selectImplementProvider).mockReturnValue({ run: vi.fn() });
    vi.mocked(runReconcilerPass).mockResolvedValue({
      blocked: true,
      reason: 'slice "s1" is stuck — needs human intervention',
      complete: false,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerStepCommands(program);
    await program.parseAsync(['node', 'sdlc', 'implement', '--run', 'r1']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stuck'));
  });
});
