import { openRepo } from './repository.js';

export async function getCurrentBranch(cwd: string): Promise<string> {
  const status = await openRepo(cwd).status();
  if (!status.current) throw new Error(`Cannot determine current branch in ${cwd}`);
  return status.current;
}
