import { faker } from '@faker-js/faker';
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { changedPaths, commitsBeyond, exactHead, hasCommit, mergeBaseWith } from './run-history.js';

describe('run history', () => {
  it('reads the exact commit a ref names, and nothing for a ref that does not exist', async () => {
    const { dir, head } = await setup();
    const branch = faker.git.branch();
    await simpleGit(dir).branch([branch]);

    expect(unwrap(await exactHead(dir, `refs/heads/${branch}`))).toBe(await head());
    expect(unwrap(await exactHead(dir, `refs/heads/${faker.string.alpha(12)}`))).toBeUndefined();
  });

  it('knows a commit that only an unreachable object keeps', async () => {
    const { dir, commit, head } = await setup();
    const start = await head();
    const orphaned = await commit({ write: { [faker.system.fileName()]: faker.lorem.word() } });
    await simpleGit(dir).reset(['--hard', start]);

    expect(unwrap(await hasCommit(dir, orphaned))).toBe(true);
    expect(unwrap(await hasCommit(dir, faker.git.commitSha()))).toBe(false);
  });

  it('lists the commits made past the starting point, newest first', async () => {
    const { commit, dir, head } = await setup();
    const start = await head();
    const first = await commit({ write: { [faker.system.fileName()]: faker.lorem.word() } });
    const second = await commit({ write: { [faker.system.fileName()]: faker.lorem.word() } });

    expect(unwrap(await commitsBeyond(dir, start, second))).toEqual([second, first]);
    expect(unwrap(await commitsBeyond(dir, second, second))).toEqual([]);
  });

  it('finds where work forked from a default branch that moved on since', async () => {
    const { commit, dir, head } = await setup();
    const fork = await head();
    const work = await commit({ write: { [faker.system.fileName()]: faker.lorem.word() } });
    await simpleGit(dir).checkout(['-b', faker.string.alpha(10), fork]);
    const defaultHead = await commit({ write: { [faker.system.fileName()]: faker.lorem.word() } });

    expect(unwrap(await mergeBaseWith(dir, defaultHead, work))).toBe(fork);
  });

  it('finds no fork point between unrelated histories', async () => {
    const { commit, dir, head } = await setup();
    const work = await head();
    await simpleGit(dir).raw(['checkout', '--orphan', faker.string.alpha(10)]);
    const unrelated = await commit({ write: { [faker.system.fileName()]: faker.lorem.word() } });

    expect(unwrap(await mergeBaseWith(dir, unrelated, work))).toBeUndefined();
  });

  it('names added, modified, deleted and retyped paths', async () => {
    const { commit, head, dir } = await setup();
    const [modified, deleted, retyped, added] = distinctNames(4);
    await commit({ write: { [modified]: 'a', [deleted]: 'b', [retyped]: 'c' } });
    const from = await head();
    const to = await commit({
      write: { [modified]: faker.lorem.paragraph(), [added]: faker.lorem.word() },
      remove: [deleted],
      link: { [retyped]: 'c' },
    });

    expect(unwrap(await changedPaths(dir, from, to)).sort()).toEqual(
      [modified, deleted, retyped, added].sort(),
    );
  });

  it('names both sides of a rename, even when git is configured to detect renames', async () => {
    const { commit, head, dir } = await setup();
    const [original, renamed] = distinctNames(2);
    await simpleGit(dir).addConfig('diff.renames', 'copies');
    await commit({ write: { [original]: faker.lorem.paragraphs(3) } });
    const from = await head();
    const to = await commit({ move: { [original]: renamed } });

    expect(unwrap(await changedPaths(dir, from, to)).sort()).toEqual([original, renamed].sort());
  });

  it('keeps unusual file names intact', async () => {
    const { commit, head, dir } = await setup();
    const from = await head();
    const unusual = [
      `with space ${faker.string.alpha(5)}`,
      `new\nline${faker.string.alpha(5)}`,
      `tab\t${faker.string.alpha(5)}`,
      `"quoted"${faker.string.alpha(5)}`,
      `ünïcødé-${faker.string.alpha(5)}`,
      `-leading-dash${faker.string.alpha(5)}`,
    ];
    const to = await commit({
      write: Object.fromEntries(unusual.map((name) => [name, faker.lorem.word()])),
    });

    expect(unwrap(await changedPaths(dir, from, to)).sort()).toEqual(unusual.sort());
  });

  it('returns a failed git command for a revision that does not exist', async () => {
    const { dir, head } = await setup();
    const missing = faker.git.commitSha();

    const diffed = await changedPaths(dir, missing, await head());
    const listed = await commitsBeyond(dir, missing, await head());

    expect(diffed.isErr() && diffed.error._tag).toBe('GitCommandFailed');
    expect(listed.isErr() && listed.error._tag).toBe('GitCommandFailed');
  });

  function distinctNames(count: number): string[] {
    return faker.helpers.uniqueArray(() => `${faker.string.alpha(8)}.txt`, count);
  }

  async function setup() {
    const { dir } = await createTempRepo();
    const git = simpleGit(dir);
    const head = () => git.revparse(['HEAD']);
    const commit = async (change: {
      write?: Record<string, string>;
      remove?: string[];
      link?: Record<string, string>;
      move?: Record<string, string>;
    }) => {
      for (const [file, contents] of Object.entries(change.write ?? {})) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await writeFile(path.join(dir, file), contents);
      }
      for (const file of change.remove ?? []) await rm(path.join(dir, file));
      for (const [file, target] of Object.entries(change.link ?? {})) {
        await rm(path.join(dir, file));
        await symlink(target, path.join(dir, file));
      }
      for (const [from, to] of Object.entries(change.move ?? {}))
        await rename(path.join(dir, from), path.join(dir, to));
      await git.raw(['add', '-A']);
      await git.commit(faker.git.commitMessage());
      return head();
    };
    return { dir, head, commit };
  }
});
