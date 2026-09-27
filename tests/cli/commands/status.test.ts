import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { registerStatusCommand } from '../../../src/cli/commands/status.js';
import { initializeRunState } from '../../../src/state/store.js';
import { createTempRepo, type TempRepo } from '../../support/temp-repo.js';

let repo: TempRepo;
let prevCwd: string;

afterEach(async () => {
  process.chdir(prevCwd);
  await repo?.cleanup();
  vi.restoreAllMocks();
});

describe('status command', () => {
  it('prints the planning doc paths when they exist', async () => {
    repo = await createTempRepo();
    prevCwd = process.cwd();
    process.chdir(repo.dir);
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    await writeFile(path.join(paths.stateDir, 'design.md'), '# Design');
    await writeFile(path.join(paths.stateDir, 'plan.md'), '# Plan');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(['node', 'sdlc', 'status', '--run', 'run1']);

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(
      logged.some((line) => line.startsWith('Design: ') && line.endsWith('state/design.md')),
    ).toBe(true);
    expect(logged.some((line) => line.startsWith('Plan: ') && line.endsWith('state/plan.md'))).toBe(
      true,
    );
  });

  it('prints no planning doc lines for a run without docs', async () => {
    repo = await createTempRepo();
    prevCwd = process.cwd();
    process.chdir(repo.dir);
    await initializeRunState(repo.dir, 'run1', 'main');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(['node', 'sdlc', 'status', '--run', 'run1']);

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('Design:'))).toBe(false);
    expect(logged.some((line) => line.includes('Plan:'))).toBe(false);
  });
});
