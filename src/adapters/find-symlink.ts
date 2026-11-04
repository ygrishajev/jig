import { Result } from 'better-result';
import { lstatSync } from 'node:fs';

import { ConfigInvalid } from '../domain/errors.js';

export function refuseSymlinks(paths: string[]): Result<void, ConfigInvalid> {
  const link = findSymlink(paths);
  return link
    ? Result.err(
        new ConfigInvalid({ message: `Refusing to write through the symbolic link ${link}.` }),
      )
    : Result.ok();
}

/**
 * Git checks out symbolic links, so a path jig writes inside a repository may lead anywhere on
 * this machine. A missing path is no link. Dangling links count: a write would create their target.
 */
export function findSymlink(paths: string[]): string | undefined {
  return paths.find((file) => lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink());
}
