import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildPrDescriptionPrompt } from '../../orchestrator/prompts.js';
import {
  readStructuredOutput,
  resetStructuredOutput,
} from '../../orchestrator/structured-output.js';
import { logRun } from '../../logging.js';
import { readPlan, readSlices } from '../../state/store.js';
import type { RunPaths } from '../../state/run-paths.js';
import type { Slice } from '../../state/types.js';
import type { AgentProvider } from '../provider/types.js';
import type { PrCreateStrategy } from './types.js';

const TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
];

export const DEFAULT_PR_TEMPLATE = [
  '## What',
  '',
  '<!-- The result, in plain words: what a user or operator can do or see now. No code, paths or jargon. -->',
  '',
  '## Why',
  '',
  '<!-- The motivation, in plain words. -->',
  '',
  '## How',
  '',
  '<!-- For reviewers: the approach and the notable decisions, a few lines. -->',
  '',
  '## Verification',
  '',
  '<!-- The commands that were run and what they reported. Say what could not be run. -->',
  '',
  '## Deletions and deviations',
  '',
  '<!-- Requirements not met or changed, work left unfinished and why. Write "None" if none. -->',
].join('\n');

const descriptionSchema = z.object({ body: z.string().min(1) });

export interface PrDescriber {
  provider: AgentProvider;
  verifyCommand?: string;
}

export class LocalPrCreateStrategy implements PrCreateStrategy {
  constructor(private readonly describer?: PrDescriber) {}

  async create(paths: RunPaths): Promise<void> {
    const plan = await readPlan(paths);
    const slices = await readSlices(paths);
    const agentRun = [
      `**${plan.summary}**`,
      '',
      plan.approach,
      '',
      this.sliceMapping(slices, '###'),
      '',
      ...(await this.planningDetails(paths)),
    ].join('\n');
    const template = await this.repoTemplate(paths);
    const described = await this.describe(paths, template ?? DEFAULT_PR_TEMPLATE, slices);
    const content = described
      ? [described, '', this.collapsed('Agent run', agentRun)].join('\n')
      : template
        ? [template, '', this.collapsed('Agent run', agentRun)].join('\n')
        : [
            '## Summary',
            '',
            plan.summary,
            '',
            '## Approach',
            '',
            plan.approach,
            '',
            this.sliceMapping(slices),
            '',
            ...(await this.planningDetails(paths)),
          ].join('\n');
    // Written to stateDir, not workspaceDir: stateDir isn't even part of the
    // workspace worktree's git working tree, so this file can never be swept
    // into a commit by a later `commitAll` — unlike workspaceDir, which is
    // exactly the mistake that landed agent scratch files in user history.
    await writeFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), content, 'utf-8');
  }

  private async describe(
    paths: RunPaths,
    template: string,
    slices: Slice[],
  ): Promise<string | undefined> {
    if (!this.describer) return undefined;
    const plan = await readPlan(paths);
    logRun(paths.runId, 'filling in the pull request description');
    try {
      await resetStructuredOutput(paths.workspaceDir);
      const result = await this.describer.provider.run({
        cwd: paths.workspaceDir,
        repoRoot: paths.repoRoot,
        prompt: buildPrDescriptionPrompt({
          template,
          plan,
          slices,
          design: await this.optionalDoc(paths, 'design.md'),
          verifyCommand: this.describer.verifyCommand,
        }),
      });
      if (!result.success) throw new Error(result.output);
      const { body } = await readStructuredOutput(paths.workspaceDir, (raw) =>
        descriptionSchema.parse(raw),
      );
      return body.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logRun(paths.runId, `PR description step failed, using the plain layout: ${message}`);
      return undefined;
    } finally {
      await resetStructuredOutput(paths.workspaceDir);
    }
  }

  private async optionalDoc(paths: RunPaths, filename: string): Promise<string | undefined> {
    const docPath = path.join(paths.stateDir, filename);
    return existsSync(docPath) ? (await readFile(docPath, 'utf-8')).trim() : undefined;
  }

  private async repoTemplate(paths: RunPaths): Promise<string | undefined> {
    for (const relative of TEMPLATE_PATHS) {
      const templatePath = path.join(paths.repoRoot, relative);
      if (existsSync(templatePath)) return (await readFile(templatePath, 'utf-8')).trim();
    }
    return undefined;
  }

  private async planningDetails(paths: RunPaths): Promise<string[]> {
    const sections: string[] = [];
    for (const [title, filename] of [
      ['Design', 'design.md'],
      ['Plan', 'plan.md'],
    ] as const) {
      const docPath = path.join(paths.stateDir, filename);
      if (!existsSync(docPath)) continue;
      sections.push(this.collapsed(title, (await readFile(docPath, 'utf-8')).trim()), '');
    }
    return sections;
  }

  private collapsed(title: string, body: string): string {
    return ['<details>', `<summary>${title}</summary>`, '', body, '', '</details>'].join('\n');
  }

  // A stuck slice's reviewer feedback is appended under its line (rather
  // than folded into the line itself) so the already-covered checkbox
  // format stays exactly as it was — this is the only thing a human reads
  // when a run is blocked and nothing got pushed/merged to show the
  // feedback any other way.
  private sliceMapping(slices: Slice[], heading = '##'): string {
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
    return [`${heading} Slices`, '', ...lines].join('\n');
  }
}
