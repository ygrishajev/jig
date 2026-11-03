import { faker } from '@faker-js/faker';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { tempDirectory } from './temp-directory.js';

export interface TempRepo {
  dir: string;
}

/** A real repository on `main` with one commit, removed once the test that asked for it finishes. */
export async function createTempRepo(): Promise<TempRepo> {
  const dir = await tempDirectory('jig-repo-');
  const git = simpleGit({ baseDir: dir });
  await git.init(['--initial-branch=main']);
  await configureCommitter(dir);
  await writeFile(path.join(dir, 'README.md'), `# ${faker.lorem.sentence()}\n`);
  await writeFile(path.join(dir, '.gitignore'), '.jig/\n');
  await git.add(['README.md', '.gitignore']);
  await git.commit(faker.git.commitMessage());
  return { dir };
}

/** A bare `origin` seeded from a fresh repository, and fresh clones of it that can commit. */
export async function createRemote() {
  const seed = await createTempRepo();
  const origin = await tempDirectory('jig-origin-');
  await simpleGit().clone(seed.dir, origin, ['--bare']);
  const cloneOf = async () => {
    const directory = await tempDirectory('jig-clone-');
    await simpleGit().clone(origin, directory);
    await configureCommitter(directory);
    return directory;
  };
  return { origin, cloneOf };
}

async function configureCommitter(repo: string) {
  const git = simpleGit({ baseDir: repo });
  await git.addConfig('user.email', faker.internet.email());
  await git.addConfig('user.name', faker.person.fullName());
  await git.addConfig('commit.gpgsign', 'false');
  await git.addConfig('pull.rebase', 'false');
}
