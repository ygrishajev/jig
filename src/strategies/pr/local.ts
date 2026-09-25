import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunPaths } from '../../state/run-paths.js';
import type { Slice } from '../../state/types.js';
import type { PrCreateStrategy } from './types.js';

export class LocalPrCreateStrategy implements PrCreateStrategy {
  async create(paths: RunPaths, slice: Slice): Promise<void> {
    const content = [`# ${slice.title}`, '', slice.description, ''].join('\n');
    await writeFile(path.join(paths.workspaceDir, 'PR_DESCRIPTION.md'), content, 'utf-8');
  }
}
