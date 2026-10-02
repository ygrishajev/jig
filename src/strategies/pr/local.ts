import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readPlan, readSlices } from '../../state/store.js';
import type { RunPaths } from '../../state/run-paths.js';
import type { Slice } from '../../state/types.js';
import type { PrCreateStrategy } from './types.js';

export class LocalPrCreateStrategy implements PrCreateStrategy {
  async create(paths: RunPaths): Promise<void> {
    const plan = await readPlan(paths);
    const slices = await readSlices(paths);
    const content = [
      `# ${plan.summary}`,
      '',
      plan.approach,
      '',
      ...(await this.planningSections(paths)),
      this.sliceMapping(slices),
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

  // A stuck slice's reviewer feedback is appended under its line (rather
  // than folded into the line itself) so the already-covered checkbox
  // format stays exactly as it was — this is the only thing a human reads
  // when a run is blocked and nothing got pushed/merged to show the
  // feedback any other way.
  private sliceMapping(slices: Slice[]): string {
    const lines = [...slices]
      .sort((a, b) => a.order - b.order)
      .flatMap((s) => {
        const line = `- [${s.status === 'merged' ? 'x' : ' '}] ${s.id} — ${s.description.split('\n')[0]}`;
        if (!s.lastFeedback) return [line];
        const feedback = s.lastFeedback
          .split('\n')
          .map((feedbackLine) => `  > ${feedbackLine}`)
          .join('\n');
        return [line, `  **[${s.status}]** reviewer feedback:`, feedback];
      });
    return ['## Slices', '', ...lines].join('\n');
  }
}
