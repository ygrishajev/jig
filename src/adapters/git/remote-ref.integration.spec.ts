import { faker } from '@faker-js/faker';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { aRunState } from '../../../tests/support/builders.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { RunStateConflict } from '../../ports/run-state-failures.js';
import { RemoteRef } from './remote-ref.js';

describe('RemoteRef', () => {
  it('reads an absent ref as missing', async () => {
    const { remote, ref } = await setup();

    expect(unwrap(await remote.list([ref])).size).toBe(0);
    expect(unwrap(await remote.peek(ref))).toBeUndefined();
  });

  it('writes JSON and reads it from another clone without moving refs or FETCH_HEAD', async () => {
    const { remote, ref, file, contents, message, cloneOf } = await setup();
    const commit = unwrap(await remote.commitFile(ref, file, contents, message));
    unwrap(await remote.pushLeased([{ ref, source: commit }]));
    const elsewhere = await cloneOf();
    const reader = new RemoteRef(elsewhere);
    const git = simpleGit({ baseDir: elsewhere });
    await git.fetch();
    const fetchHead = await readFile(path.join(elsewhere, '.git/FETCH_HEAD'), 'utf8');
    const refs = await git.raw(['show-ref']);

    const files = unwrap(await reader.peek(ref));

    expect(files?.get(file)).toBe(contents);
    expect(unwrap(await reader.list([ref])).get(ref)).toBe(commit);
    expect(await git.raw(['show-ref'])).toBe(refs);
    expect(await readFile(path.join(elsewhere, '.git/FETCH_HEAD'), 'utf8')).toBe(fetchHead);
    expect(await git.raw(['log', '-1', '--format=%s', commit])).toBe(`${message}\n`);
  });

  it('refuses a leased push after another clone moves the ref', async () => {
    const { remote, ref, file, contents, message, cloneOf } = await setup();
    const first = unwrap(await remote.commitFile(ref, file, contents, message));
    unwrap(await remote.pushLeased([{ ref, source: first }]));
    const other = new RemoteRef(await cloneOf());
    unwrap(await other.fetch([`+${ref}:${ref}`]));
    const moved = unwrap(await other.commitFile(ref, file, JSON.stringify(aRunState()), message));
    unwrap(await other.pushLeased([{ ref, expected: first, source: moved }]));
    const ours = unwrap(await remote.commitFile(ref, file, JSON.stringify(aRunState()), message));

    const pushed = await remote.pushLeased([{ ref, expected: first, source: ours }]);

    expect(pushed.isErr()).toBe(true);
    expect(pushed.isErr() && pushed.error).toBeInstanceOf(RunStateConflict);
    expect(unwrap(await remote.list([ref])).get(ref)).toBe(moved);
  });

  async function setup() {
    const { cloneOf } = await createRemote();
    const state = aRunState();
    return {
      remote: new RemoteRef(await cloneOf()),
      cloneOf,
      ref: `refs/jig/${state.runId}`,
      file: `${faker.string.uuid()}.json`,
      contents: `  ${JSON.stringify(state)}\n\n`,
      message: faker.git.commitMessage(),
    };
  }
});
