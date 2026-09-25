import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export interface TempRepo {
  dir: string;
  cleanup: () => Promise<void>;
}

export async function createTempRepo(): Promise<TempRepo> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sdlc-test-'));
  const git = simpleGit({ baseDir: dir });
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.addConfig('commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'README.md'), '# test repo\n');
  await git.add('README.md');
  await git.commit('initial commit');
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
