import { faker } from '@faker-js/faker';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { LocalStateUnwritable, RunInProgress } from '../../domain/errors.js';
import { lockRun } from './run-lock.js';

describe('lockRun', () => {
  it.each([
    { link: '.jig', linksTo: 'directory' },
    { link: '.jig/.gitignore', linksTo: 'file' },
    { link: '.jig/{id}', linksTo: 'directory' },
    { link: '.jig/{id}/run.lock', linksTo: 'file' },
    { link: '.jig/{id}/state', linksTo: 'directory' },
    { link: '.jig/{id}/state/design.md', linksTo: 'file' },
    { link: '.jig/{id}/state/run.json', linksTo: 'file' },
  ] as const)('refuses a run when $link is a symbolic link', async ({ link, linksTo }) => {
    const { repoRoot, id, plantLink } = await setup();
    const { linkPath, outside, untouched } = await plantLink(link, linksTo);

    const refusal = await lockRun(repoRoot, id);

    expect(refusal.isErr() && refusal.error).toBeInstanceOf(LocalStateUnwritable);
    expect(refusal.isErr() && refusal.error).toMatchObject({ path: linkPath });
    await untouched();
    expect(existsSync(outside)).toBe(true);
  });

  it('refuses a second process on the same run', async () => {
    const { repoRoot, id } = await setup();
    const release = (await lockRun(repoRoot, id)).unwrap();

    const second = await lockRun(repoRoot, id);

    expect(second.isErr() && second.error).toBeInstanceOf(RunInProgress);
    await release();
  });

  it('lets the next writer in once the first releases the run', async () => {
    const { repoRoot, id } = await setup();
    await (await lockRun(repoRoot, id)).unwrap()();

    const release = (await lockRun(repoRoot, id)).unwrap();

    await release();
  });

  it('locks each run on its own', async () => {
    const { repoRoot, id } = await setup();
    const release = (await lockRun(repoRoot, id)).unwrap();

    const other = (await lockRun(repoRoot, runId())).unwrap();

    await other();
    await release();
  });

  async function setup() {
    const repoRoot = await tempDirectory('jig-lock-');
    const id = runId();
    const plantLink = async (link: string, linksTo: 'directory' | 'file') => {
      const linkPath = path.join(repoRoot, link.replace('{id}', id));
      const outsideDirectory = await tempDirectory('jig-outside-');
      const contents = faker.lorem.sentence();
      const outside = path.join(outsideDirectory, faker.string.uuid());
      await writeFile(outside, contents);
      await mkdir(path.dirname(linkPath), { recursive: true });
      await symlink(linksTo === 'directory' ? outsideDirectory : outside, linkPath);
      const untouched = async () => {
        expect(await readFile(outside, 'utf-8')).toBe(contents);
        expect(await readdir(outsideDirectory)).toEqual([path.basename(outside)]);
      };
      return { linkPath, outside, untouched };
    };
    return { repoRoot, id, plantLink };
  }
});
