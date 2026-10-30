import type { AwilixContainer } from 'awilix';

import type { LogFormat } from '../adapters/logging/create-logger.js';
import { type AppCradle, createAppContainer } from '../app/container.js';
import { ensureRepositoryRoot } from '../git/repository.js';

/** Where the CLI was started and what it was started with; the only reads of `process`. */
export interface Invocation {
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

/** Runs a command against the repository in the working directory, then releases what it opened. */
export async function withApp<T>(
  logFormat: LogFormat,
  command: (app: AwilixContainer<AppCradle>) => Promise<T>,
  { cwd, environment }: Invocation = { cwd: process.cwd(), environment: process.env },
) {
  await ensureRepositoryRoot(cwd);
  const app = createAppContainer({ repoRoot: cwd, logFormat, environment });
  try {
    return await command(app);
  } finally {
    await app.dispose();
  }
}
