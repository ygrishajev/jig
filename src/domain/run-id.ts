import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

/**
 * `<name>-<random>`: the name, from the request's first `# heading` or else its file name, lets a
 * person tell runs apart in branches and worktrees; the random part keeps two runs of the same
 * request apart. A request with no heading and no file is named `stdin-<random>`.
 */
export function newRunId({ text, file }: { text: string; file?: string }): RunId {
  const name =
    slugOf(firstHeading(text) ?? '') || slugOf(file ? path.parse(file).name : '') || 'stdin';
  return runIdSchema.parse(`${name}-${randomBytes(4).toString('hex')}`);
}

function slugOf(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return shortened(slug);
}

function shortened(slug: string): string {
  if (slug.length <= MAX_NAME_LENGTH) return slug;
  const cut = slug.slice(0, MAX_NAME_LENGTH);
  const endsOnWord = slug[MAX_NAME_LENGTH] === '-';
  const lastBreak = cut.lastIndexOf('-');
  return endsOnWord || lastBreak < 0 ? cut.replace(/-$/, '') : cut.slice(0, lastBreak);
}

/** Keeps a branch name short enough to read in `git branch` and a terminal prompt. */
const MAX_NAME_LENGTH = 40;

function firstHeading(markdown: string): string | undefined {
  return /^#[ \t]+(.+)$/m.exec(markdown)?.[1];
}

/**
 * A run id becomes a `.jig/<runId>` directory, a `jig/run/<runId>` branch and a
 * `refs/jig/<runId>` ref, so only lowercase letters, digits and hyphens get through.
 */
export const runIdSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'a run id is lowercase letters, digits and hyphens')
  .brand<'RunId'>();

export type RunId = z.infer<typeof runIdSchema>;
