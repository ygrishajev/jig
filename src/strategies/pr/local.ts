import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunPaths } from '../../state/run-paths.js';
import type { Slice } from '../../state/types.js';
import type { PrCreateStrategy } from './types.js';

export class LocalPrCreateStrategy implements PrCreateStrategy {
  async create(paths: RunPaths, slice: Slice): Promise<void> {
    const content = [`# ${slice.title}`, '', slice.description, ''].join('\n');
    // Written to stateDir, not workspaceDir: stateDir isn't even part of the
    // workspace worktree's git working tree, so this file can never be swept
    // into a commit by a later `commitAll` — unlike workspaceDir, which is
    // exactly the mistake that landed agent scratch files in user history.
    await writeFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), content, 'utf-8');
  }
}
