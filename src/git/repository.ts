import { simpleGit, type SimpleGit } from 'simple-git';

export function openRepo(cwd: string): SimpleGit {
  return simpleGit({ baseDir: cwd });
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const status = await openRepo(cwd).status();
  return status.isClean();
}

export async function commitAll(cwd: string, message: string): Promise<string | null> {
  const git = openRepo(cwd);
  if (await isWorkingTreeClean(cwd)) return null;
  await git.add('-A');
  const result = await git.commit(message);
  return result.commit;
}
