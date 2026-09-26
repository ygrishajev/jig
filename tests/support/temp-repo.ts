import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export interface TempRepo {
  dir: string;
  cleanup: () => Promise<void>;
}

export async function createTempRepo(): Promise<TempRepo> {
  return createTempRepoWith({ gitignoreSdlc: true });
}

// A real target repo the tool is pointed at has never heard of `.sdlc/` and
// has no reason to list it in its own tracked .gitignore. `createTempRepo`
// pre-ignores it as a Task 14 fix for a different problem, which makes it
// unsuitable for reproducing bugs that only show up when `.sdlc/` is
// genuinely untracked from the target repo's point of view.
export async function createTempRepoWithoutSdlcIgnore(): Promise<TempRepo> {
  return createTempRepoWith({ gitignoreSdlc: false });
}

async function createTempRepoWith(options: { gitignoreSdlc: boolean }): Promise<TempRepo> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sdlc-test-'));
  const git = simpleGit({ baseDir: dir });
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.addConfig('commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'README.md'), '# test repo\n');
  const gitignoreContents = options.gitignoreSdlc ? '.sdlc/\n' : '';
  await writeFile(path.join(dir, '.gitignore'), gitignoreContents);
  await git.add(['README.md', '.gitignore']);
  await git.commit('initial commit');
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
