import { faker } from '@faker-js/faker';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, loadConfig } from './load-config.js';

describe('loadConfig', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('runs every step on claude, merging by hand, when the repository has no config', async () => {
    const config = loadConfig(await setup());

    expect(config).toMatchObject({
      mergeMode: 'manual',
      designGate: 'auto',
      commitSigning: 'repo',
      planner: { provider: 'claude' },
      implementer: { provider: 'claude' },
      reviewer: { provider: 'claude' },
      describer: { provider: 'claude' },
    });
  });

  it('takes per-step agents and models from the config file', async () => {
    const model = `openrouter/${faker.word.noun()}`;
    const verifyCommand = `npm run ${faker.word.verb()}`;

    const config = loadConfig(
      await setup({
        implementer: { provider: 'opencode', model },
        verifyCommand,
        commitSigning: 'skip',
      }),
    );

    expect(config).toMatchObject({
      implementer: { provider: 'opencode', model },
      verifyCommand,
      commitSigning: 'skip',
    });
  });

  it('takes the commands that prepare and check the sandbox', async () => {
    const setupCommand = `npm ${faker.word.verb()}`;

    const config = loadConfig(await setup({ setupCommand, setupTimeoutSeconds: 120 }));

    expect(config).toMatchObject({ setupCommand, setupTimeoutSeconds: 120 });
  });

  it('rejects a misspelled key instead of ignoring it', async () => {
    const repoRoot = await setup({ implement: { provider: 'claude' } });

    expect(() => loadConfig(repoRoot)).toThrow();
  });

  it('rejects an agent it does not know', async () => {
    const repoRoot = await setup({ reviewer: { provider: faker.word.noun() } });

    expect(() => loadConfig(repoRoot)).toThrow();
  });

  it('takes a version pin for a known agent and rejects one for an agent it does not know', async () => {
    const version = faker.system.semver();

    expect(loadConfig(await setup({ agents: { opencode: version } })).agents).toEqual({
      opencode: version,
    });
    const repoRoot = await setup({ agents: { [faker.word.noun()]: version } });
    expect(() => loadConfig(repoRoot)).toThrow();
  });

  async function setup(contents?: Record<string, unknown>) {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'sdlc-config-'));
    directories.push(repoRoot);
    if (contents) await writeFile(path.join(repoRoot, CONFIG_FILE), JSON.stringify(contents));
    return repoRoot;
  }
});
