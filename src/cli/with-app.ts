import type { AwilixContainer } from 'awilix';
import { Result } from 'better-result';

import type { LogFormat } from '../adapters/logging/create-logger.js';
import { type AppCradle, createAppContainer } from '../app/container.js';
import { parseEnvironment } from '../config/environment.js';
import { loadConfig } from '../config/load-config.js';
import type { JigError } from '../domain/errors.js';
import { ensureRepositoryRoot } from '../git/repository.js';

/** Where the CLI was started and what it was started with; the only reads of `process`. */
export interface Invocation {
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

/** Runs a command against the repository in the working directory, then releases what it opened. */
export async function withApp<T>(
  logFormat: LogFormat,
  command: (app: AwilixContainer<AppCradle>) => Promise<Result<T, JigError>>,
  { cwd, environment }: Invocation = { cwd: process.cwd(), environment: process.env },
): Promise<Result<T, JigError>> {
  const root = await ensureRepositoryRoot(cwd);
  if (root.isErr()) return Result.err(root.error);
  const parsedEnvironment = parseEnvironment(environment);
  if (parsedEnvironment.isErr()) return Result.err(parsedEnvironment.error);
  const config = loadConfig(cwd);
  if (config.isErr()) return Result.err(config.error);
  const app = createAppContainer({
    repoRoot: cwd,
    logFormat,
    environment: parsedEnvironment.value,
    config: config.value,
  });
  try {
    return await command(app);
  } finally {
    await app.dispose();
  }
}
