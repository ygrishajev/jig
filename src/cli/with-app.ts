import type { AwilixContainer } from 'awilix';
import type { LogFormat } from '../adapters/logging/create-logger.js';
import { createAppContainer, type AppCradle } from '../app/container.js';

/** Runs a command against the repository in the working directory, then releases what it opened. */
export async function withApp<T>(
  logFormat: LogFormat,
  command: (app: AwilixContainer<AppCradle>) => Promise<T>,
) {
  const app = createAppContainer({ repoRoot: process.cwd(), logFormat });
  try {
    return await command(app);
  } finally {
    await app.dispose();
  }
}
