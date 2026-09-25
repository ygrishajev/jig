import { openRepo } from './repository.js';

export async function getCurrentBranch(cwd: string): Promise<string> {
  const status = await openRepo(cwd).status();
  if (!status.current) throw new Error(`Cannot determine current branch in ${cwd}`);
  return status.current;
}

export async function localBranchExists(cwd: string, branchName: string): Promise<boolean> {
  const summary = await openRepo(cwd).branchLocal();
  return Object.hasOwn(summary.branches, branchName);
}

export async function createBranchFrom(
  cwd: string,
  branchName: string,
  fromRef: string,
): Promise<void> {
  await openRepo(cwd).branch([branchName, fromRef]);
}

export async function checkoutExistingBranch(cwd: string, branchName: string): Promise<void> {
  await openRepo(cwd).checkout(branchName);
}

export async function checkoutNewBranchAt(
  cwd: string,
  branchName: string,
  startPoint: string,
): Promise<void> {
  await openRepo(cwd).checkoutBranch(branchName, startPoint);
}
