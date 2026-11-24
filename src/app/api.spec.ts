import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { aMetricsSummary, aRunState, presetName } from '../../tests/support/builders.js';
import { InMemoryConfigSource, InMemoryPresetSource } from '../../tests/support/fakes.js';
import {
  operationContextIn,
  realRepositorySources,
} from '../../tests/support/repository-sources.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { ConfigInvalid } from '../config/errors.js';
import { RepositoryInvalid } from '../ports/git-failures.js';
import { LocalPreparationFailed } from '../ports/local-state.js';
import type { RunRecords } from '../ports/run-records.js';
import { listPresets, readRunStatus, type RepositorySources } from './api.js';
import { RunRequestInvalid } from './errors.js';

describe('application API', () => {
  describe('readRunStatus', () => {
    it("returns the saved run with this machine's metrics and documents for it", async () => {
      const { status, saveRun, records } = await setup();
      const state = await saveRun();
      const metrics = aMetricsSummary();
      const documents = [{ name: 'plan.md' as const, path: faker.system.filePath() }];
      records.metricsSummary.mockReturnValue(Result.ok(metrics));
      records.documents.mockReturnValue(documents);

      const result = unwrap(await status({ runId: state.runId }));

      expect(result).toEqual({ state, metrics, documents });
      expect(records.metricsSummary).toHaveBeenCalledWith(state.runId);
      expect(records.documents).toHaveBeenCalledWith(state.runId);
    });

    it('reads a run without an agent credential in the environment and leaves every file under .jig as it was', async () => {
      const { status, saveRun, jigDirectory } = await setup({ environment: {} });
      const state = await saveRun();
      const before = await jigDirectory();

      const result = await status({ runId: state.runId });

      expect(result.isOk()).toBe(true);
      expect(await jigDirectory()).toEqual(before);
    });

    it('reads the config file it was given, relative to the repository root', async () => {
      const { status, saveRun, sources, repoRoot } = await setup();
      const state = await saveRun();
      const configPath = `${faker.word.noun()}.json`;

      unwrap(await status({ runId: state.runId, configPath }));

      expect(sources.configSourceFor).toHaveBeenCalledWith(repoRoot, configPath);
    });

    it('refuses a directory the repository check refuses before reading anything from it', async () => {
      const refusal = new RepositoryInvalid({ message: faker.lorem.sentence() });
      const { status, sources, records } = await setup({ repository: Result.err(refusal) });

      const result = await status({ runId: aRunState().runId });

      expect(result.isErr() && result.error).toBe(refusal);
      expect(sources.readSavedCredentials).not.toHaveBeenCalled();
      expect(sources.configSourceFor).not.toHaveBeenCalled();
      expect(records.metricsSummary).not.toHaveBeenCalled();
    });

    it('refuses an environment it cannot parse before reading the saved credentials', async () => {
      const { status, sources } = await setup({
        environment: { JIG_IMAGE_CACHE: faker.word.noun() },
      });

      const result = await status({ runId: aRunState().runId });

      expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
      expect(sources.readSavedCredentials).not.toHaveBeenCalled();
    });

    it('refuses saved credentials it cannot read before reading the config', async () => {
      const refusal = new LocalPreparationFailed({ message: faker.lorem.sentence() });
      const { status, sources, records } = await setup({ savedCredentials: Result.err(refusal) });

      const result = await status({ runId: aRunState().runId });

      expect(result.isErr() && result.error).toBe(refusal);
      expect(sources.configSourceFor).not.toHaveBeenCalled();
      expect(records.metricsSummary).not.toHaveBeenCalled();
    });

    it("refuses a config it cannot read before looking for the run or this machine's records", async () => {
      const { status, saveRun, records } = await setup({
        configSource: new InMemoryConfigSource({ failure: 'unreadable' }),
      });
      const state = await saveRun();

      const result = await status({ runId: state.runId });

      expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
      expect(records.metricsSummary).not.toHaveBeenCalled();
      expect(records.documents).not.toHaveBeenCalled();
    });

    it("refuses a run no store holds without reading this machine's records", async () => {
      const { status, records } = await setup();

      const result = await status({ runId: aRunState().runId });

      expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
      expect(records.metricsSummary).not.toHaveBeenCalled();
    });
  });

  describe('listPresets', () => {
    it('lists the presets found under the repository and the home directory the environment names', async () => {
      const presetSource = new InMemoryPresetSource();
      const name = presetName();
      const label = presetSource.put(faker.number.int({ min: 0, max: 3 }), name, {});
      const home = faker.system.directoryPath();
      const { presets, sources, repoRoot } = await setup({
        presetSource,
        environment: { HOME: home },
      });

      const listed = unwrap(await presets());

      expect(listed.map((preset) => [preset.name, preset.label])).toEqual([[name, label]]);
      expect(sources.presetSourceFor).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot, homeDirectory: home }),
      );
    });

    it('refuses a config it cannot read before listing any preset', async () => {
      const presetSource = new InMemoryPresetSource();
      const { presets } = await setup({
        presetSource,
        configSource: new InMemoryConfigSource({ failure: 'not-json' }),
      });

      const result = await presets();

      expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
      expect(presetSource.listings).toBe(0);
    });

    it('refuses a directory the repository check refuses before looking for presets', async () => {
      const refusal = new RepositoryInvalid({ message: faker.lorem.sentence() });
      const { presets, sources } = await setup({ repository: Result.err(refusal) });

      const result = await presets();

      expect(result.isErr() && result.error).toBe(refusal);
      expect(sources.presetSourceFor).not.toHaveBeenCalled();
    });
  });

  async function setup(
    input: {
      environment?: Record<string, string>;
      repository?: Result<void, RepositoryInvalid>;
      savedCredentials?: ReturnType<RepositorySources['readSavedCredentials']>;
      configSource?: InMemoryConfigSource;
      presetSource?: InMemoryPresetSource;
    } = {},
  ) {
    const repo = await createTempRepo();
    const real = realRepositorySources();
    const configSource = input.configSource ?? new InMemoryConfigSource({ json: {} });
    const sources = {
      ensureRepositoryRoot: vi.fn(
        input.repository ? async () => input.repository! : real.ensureRepositoryRoot,
      ),
      readSavedCredentials: vi.fn(
        input.savedCredentials ? () => input.savedCredentials! : real.readSavedCredentials,
      ),
      configSourceFor: vi.fn(() => configSource),
      presetSourceFor: vi.fn(() => input.presetSource ?? new InMemoryPresetSource()),
    } satisfies RepositorySources;
    const records = mock<RunRecords>({
      metricsSummary: vi.fn().mockReturnValue(Result.ok(aMetricsSummary())),
      documents: vi.fn().mockReturnValue([]),
    });
    const context = () => operationContextIn(repo.dir, input.environment);
    return {
      repoRoot: repo.dir,
      sources,
      records,
      status: (statusInput: Parameters<typeof readRunStatus>[1]) =>
        readRunStatus({ ...sources, context, runRecordsAt: () => records }, statusInput),
      presets: () => listPresets({ ...sources, context }),
      saveRun: async () => {
        const state = aRunState();
        unwrap(await new LocalRunStore(repo.dir).save(state));
        return state;
      },
      jigDirectory: () => filesUnder(path.join(repo.dir, '.jig')),
    };
  }
});

async function filesUnder(directory: string) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  return Promise.all(
    files.map(async (entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(directory, file), await readFile(file, 'utf-8')];
    }),
  );
}
