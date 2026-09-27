import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readSlices } from '../../state/store.js';
import type { RunPaths } from '../../state/run-paths.js';
import type { Slice } from '../../state/types.js';
import type { PrCreateStrategy } from './types.js';

export class LocalPrCreateStrategy implements PrCreateStrategy {
  async create(paths: RunPaths, slice: Slice): Promise<void> {
    const content = [
      `# ${slice.title}`,
      '',
      slice.description,
      '',
      ...(await this.planningSections(paths)),
      await this.sliceMapping(paths, slice),
    ].join('\n');
    // Written to stateDir, not workspaceDir: stateDir isn't even part of the
    // workspace worktree's git working tree, so this file can never be swept
    // into a commit by a later `commitAll` — unlike workspaceDir, which is
    // exactly the mistake that landed agent scratch files in user history.
    await writeFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), content, 'utf-8');
  }

  private async planningSections(paths: RunPaths): Promise<string[]> {
    const sections: string[] = [];
    for (const [title, filename] of [
      ['## Design', 'design.md'],
      ['## Plan', 'plan.md'],
    ] as const) {
      const docPath = path.join(paths.stateDir, filename);
      if (!existsSync(docPath)) continue;
      sections.push(title, '', (await readFile(docPath, 'utf-8')).trim(), '');
    }
    return sections;
  }

  private async sliceMapping(paths: RunPaths, slice: Slice): Promise<string> {
    let slices: Slice[];
    try {
      slices = await readSlices(paths);
    } catch {
      slices = [slice];
    }
    const lines = slices.map((s) => {
      const entry = `- ${s.id} — ${s.description.split('\n')[0]}`;
      return s.id === slice.id ? entry.replace(/^- /, '**▶ ') + '**' : entry;
    });
    return ['## Slices', '', ...lines].join('\n');
  }
}
