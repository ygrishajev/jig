import { existsSync } from 'node:fs';
import path from 'node:path';

/** A tool that installs a repository's git hooks, and the command that does so in a fresh clone. */
export interface HookManager {
  name: string;
  installCommand: string;
  isUsedIn(repoRoot: string): boolean;
}

/**
 * The manager whose hooks the sandbox's clone needs. A clone has none: they are installed by an
 * npm script or by hand, and a repository may disable install scripts.
 */
export function hookManagerOf(repoRoot: string): HookManager | undefined {
  return HOOK_MANAGERS.find((manager) => manager.isUsedIn(repoRoot));
}

/**
 * The hook managers jig installs in the sandbox, tried in order. Each `npx --no` uses the copy
 * the setup command installed and never fetches one from the registry.
 */
const HOOK_MANAGERS: readonly HookManager[] = [
  {
    name: 'husky',
    installCommand: 'npx --no -- husky',
    isUsedIn: (repoRoot) => existsSync(path.join(repoRoot, '.husky')),
  },
];
