import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { hookManagerOf } from './git-hooks.js';

describe('hookManagerOf', () => {
  it('installs husky in a repository with a .husky directory', async () => {
    const { repoRoot } = await setup({ husky: true });

    expect(hookManagerOf(repoRoot)).toMatchObject({
      name: 'husky',
      installCommand: 'npx --no -- husky',
    });
  });

  it('installs nothing in a repository without a hook manager', async () => {
    const { repoRoot } = await setup({ husky: false });

    expect(hookManagerOf(repoRoot)).toBeUndefined();
  });

  async function setup(input: { husky: boolean }) {
    const repoRoot = await tempDirectory('jig-hooks-');
    if (input.husky) await mkdir(path.join(repoRoot, '.husky'));
    return { repoRoot };
  }
});
