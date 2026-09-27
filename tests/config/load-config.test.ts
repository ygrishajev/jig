import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../src/config/load-config.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    repo = await createTempRepo();
    const config = loadConfig(repo.dir);
    expect(config.mergeMode).toBe('manual');
    expect(config.reviewCycleCap).toBe(3);
    expect(config.conflictResolveCap).toBe(3);
    expect(config.inputSource).toBe('markdown-file');
    expect(config.planner).toEqual({ provider: 'claude' });
    expect(config.implementer).toEqual({ provider: 'claude' });
    expect(config.reviewer).toEqual({ provider: 'claude' });
    expect(config.designGate).toBe('auto');
    expect(config.commitSigning).toBe('repo');
  });

  it('merges values from sdlc.config.json over defaults', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'sdlc.config.json'),
      JSON.stringify({ mergeMode: 'auto', verifyCommand: 'npm test' }),
    );
    const config = loadConfig(repo.dir);
    expect(config.mergeMode).toBe('auto');
    expect(config.verifyCommand).toBe('npm test');
    expect(config.reviewCycleCap).toBe(3);
  });

  it('accepts per-step provider and model configuration', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'sdlc.config.json'),
      JSON.stringify({
        planner: { provider: 'claude', model: 'claude-sonnet-4-5' },
        implementer: { provider: 'opencode', model: 'openrouter/~z-ai/glm-flash-latest' },
        reviewer: { provider: 'opencode', model: 'openrouter/~z-ai/glm-4.6' },
      }),
    );
    const config = loadConfig(repo.dir);
    expect(config.planner).toEqual({ provider: 'claude', model: 'claude-sonnet-4-5' });
    expect(config.implementer).toEqual({
      provider: 'opencode',
      model: 'openrouter/~z-ai/glm-flash-latest',
    });
    expect(config.reviewer).toEqual({ provider: 'opencode', model: 'openrouter/~z-ai/glm-4.6' });
  });

  it('accepts a step entry with a provider only', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'sdlc.config.json'),
      JSON.stringify({ implementer: { provider: 'opencode' } }),
    );
    const config = loadConfig(repo.dir);
    expect(config.implementer).toEqual({ provider: 'opencode' });
  });

  it('accepts designGate checkpoint', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'sdlc.config.json'),
      JSON.stringify({ designGate: 'checkpoint' }),
    );
    expect(loadConfig(repo.dir).designGate).toBe('checkpoint');
  });

  it('throws on an invalid designGate value', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'sdlc.config.json'),
      JSON.stringify({ designGate: 'maybe' }),
    );
    expect(() => loadConfig(repo.dir)).toThrow();
  });

  it('accepts commitSigning skip', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'sdlc.config.json'),
      JSON.stringify({ commitSigning: 'skip' }),
    );
    expect(loadConfig(repo.dir).commitSigning).toBe('skip');
  });

  it('throws on an invalid commitSigning value', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'sdlc.config.json'),
      JSON.stringify({ commitSigning: 'sometimes' }),
    );
    expect(() => loadConfig(repo.dir)).toThrow();
  });

  it('throws on an invalid mergeMode value', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'sdlc.config.json'),
      JSON.stringify({ mergeMode: 'sometimes' }),
    );
    expect(() => loadConfig(repo.dir)).toThrow();
  });

  it('throws on an unknown provider in a step entry', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'sdlc.config.json'),
      JSON.stringify({ planner: { provider: 'cursor' } }),
    );
    expect(() => loadConfig(repo.dir)).toThrow();
  });

  it('throws on an unknown step key', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'sdlc.config.json'),
      JSON.stringify({ architect: { provider: 'claude' } }),
    );
    expect(() => loadConfig(repo.dir)).toThrow();
  });
});
