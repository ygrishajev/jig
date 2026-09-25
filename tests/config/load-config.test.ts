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
    expect(config.providerCommand).toBe('claude');
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

  it('throws on an invalid mergeMode value', async () => {
    repo = await createTempRepo();
    await writeFile(path.join(repo.dir, 'sdlc.config.json'), JSON.stringify({ mergeMode: 'sometimes' }));
    expect(() => loadConfig(repo.dir)).toThrow();
  });
});
