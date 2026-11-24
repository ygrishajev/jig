import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { messageOf } from '../../failures/messages.js';
import { SandboxPreparationInvalid } from '../../ports/agent-session.js';
import { LocalPreparationFailed } from '../../ports/local-state.js';
import type { StarterFiles } from '../../ports/starter-files.js';
import type { ConfigDestination } from '../filesystem/config-source.js';
import { refuseSymlinks } from '../find-symlink.js';
import { ignoreSandcastleDirectory } from '../sandcastle/sandcastle-session.js';
import { BASE_DOCKERFILE, DOCKERFILE, SANDBOX_DIRECTORY, withToolchain } from './image-recipe.js';

/** The sandbox Dockerfile under `.sandcastle/` and the config `configDestination` names. */
export class RepositoryStarterFiles implements StarterFiles {
  constructor(
    private readonly repoRoot: string,
    private readonly configDestination: ConfigDestination,
  ) {}

  async writeMissing(): Promise<Result<void, LocalPreparationFailed | SandboxPreparationInvalid>> {
    const ignored = await ignoreSandcastleDirectory(this.repoRoot);
    if (ignored.isErr()) return ignored;
    const dockerfile = sandboxDockerfilePath(this.repoRoot);
    const config = this.configDestination.path;
    const refused = refuseSymlinks([dockerfile, config]);
    if (refused.isErr()) return refused;
    const written = await writeIfMissing(dockerfile, BASE_DOCKERFILE);
    if (written.isErr()) return written;
    return writeIfMissing(config, '{}\n');
  }

  readDockerfile(): Promise<Result<string, SandboxPreparationInvalid>> {
    return readSandboxDockerfile(this.repoRoot);
  }

  async writeToolchain(
    toolchain: string,
  ): Promise<Result<void, SandboxPreparationInvalid | LocalPreparationFailed>> {
    const dockerfile = await this.readDockerfile();
    const filled = dockerfile.andThen((contents) => withToolchain(contents, toolchain));
    if (filled.isErr()) return Result.err(filled.error);
    return writeRepoFile(sandboxDockerfilePath(this.repoRoot), filled.value);
  }
}

function sandboxDockerfilePath(repoRoot: string): string {
  return path.join(repoRoot, SANDBOX_DIRECTORY, DOCKERFILE);
}

function writeIfMissing(
  file: string,
  contents: string,
): Promise<Result<void, LocalPreparationFailed>> {
  return existsSync(file) ? Promise.resolve(Result.ok()) : writeRepoFile(file, contents);
}

function writeRepoFile(
  file: string,
  contents: string,
): Promise<Result<void, LocalPreparationFailed>> {
  return Result.tryPromise({
    try: () => writeFile(file, contents),
    catch: (cause) =>
      new LocalPreparationFailed({ message: `Could not write ${file}: ${messageOf(cause)}` }),
  });
}

export async function readSandboxDockerfile(
  repoRoot: string,
): Promise<Result<string, SandboxPreparationInvalid>> {
  const file = sandboxDockerfilePath(repoRoot);
  const shown = path.join(SANDBOX_DIRECTORY, DOCKERFILE);
  if (!existsSync(file)) {
    return Result.err(
      new SandboxPreparationInvalid({
        message: `No sandbox Dockerfile at ${shown} — run jig init first.`,
      }),
    );
  }
  return Result.tryPromise({
    try: () => readFile(file, 'utf-8'),
    catch: (cause) =>
      new SandboxPreparationInvalid({
        message: `Could not read the sandbox Dockerfile at ${shown}: ${messageOf(cause)}`,
      }),
  });
}
