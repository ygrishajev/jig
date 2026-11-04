import { simpleGit } from 'simple-git';

/** Commits everything in a repository the host owns, the way an operator would. */
export async function commitAll(cwd: string, message: string) {
  const git = simpleGit({ baseDir: cwd });
  await git.add('-A');
  return (await git.commit(message)).commit;
}
