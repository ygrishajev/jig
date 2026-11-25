import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { aMetricsSummary, aRunState, presetName, runId } from '../../tests/support/builders.js';
import {
  InMemoryConfigSource,
  InMemoryPresetSource,
  InMemoryRunStore,
} from '../../tests/support/fakes.js';
import {
  localRunRuntime,
  operationContextIn,
  repositorySourcesAt,
} from '../../tests/support/repository-sources.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { lockRun } from '../adapters/local-store/run-lock.js';
import { RepositoryRunStores } from '../adapters/run-store/repository-run-stores.js';
import { ConfigInvalid } from '../config/errors.js';
import { SandboxCredentialsInvalid } from '../ports/agent-session.js';
import { RepositoryInvalid } from '../ports/git-failures.js';
import { LocalPreparationFailed } from '../ports/local-state.js';
import type { RunRecords } from '../ports/run-records.js';
import { RunInProgress } from '../ports/run-state-failures.js';
import type { RunStoreCatalog } from '../ports/run-store.js';
import {
  type JigOperations,
  listPresets,
  type Preset,
  type PresetPick,
  readRunStatus,
  type RepositorySources,
  type RunInput,
  type RunLog,
  RunRequestInvalid,
  type RunSandbox,
  type RuntimeRequest,
  startOrResumeRun,
} from './api.js';

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

    it('refuses a directory below the repository root before reading anything from it', async () => {
      const { status, sources, records } = await setup({ startInSubdirectory: true });

      const result = await status({ runId: aRunState().runId });

      expect(result.isErr() && result.error).toBeInstanceOf(RepositoryInvalid);
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

    it('reads the run from whichever store implementation it is bound to', async () => {
      const store = new InMemoryRunStore();
      const state = aRunState();
      unwrap(await store.save(state));
      const { status, repoRoot } = await setup({ runStores: catalogOver(store) });

      const result = unwrap(await status({ runId: state.runId }));

      expect(result.state).toEqual(state);
      expect(unwrap(await new LocalRunStore(repoRoot).load(state.runId))).toBeUndefined();
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

    it('refuses a directory below the repository root before looking for presets', async () => {
      const { presets, sources } = await setup({ startInSubdirectory: true });

      const result = await presets();

      expect(result.isErr() && result.error).toBeInstanceOf(RepositoryInvalid);
      expect(sources.configSourceFor).not.toHaveBeenCalled();
      expect(sources.presetSourceFor).not.toHaveBeenCalled();
    });
  });

  describe('startOrResumeRun', () => {
    it('starts a run under the id it was given, resumes it for the same request and refuses another', async () => {
      const { run, repoRoot, runtimes } = await setup();
      const id = runId();
      const text = `# ${faker.lorem.sentence()}`;

      const first = await run({ run: { start: { text }, runId: id } });
      const started = unwrap(await new LocalRunStore(repoRoot).load(id));
      const again = await run({ run: { start: { text }, runId: id } });
      const other = await run({ run: { start: { text: faker.lorem.paragraph() }, runId: id } });

      expect(first.isErr() && first.error).toBeInstanceOf(SandboxCredentialsInvalid);
      expect(started).toMatchObject({ runId: id, request: text });
      expect(again.isErr() && again.error).toBeInstanceOf(SandboxCredentialsInvalid);
      expect(unwrap(await new LocalRunStore(repoRoot).load(id))).toEqual(started);
      expect(other.isErr() && other.error).toBeInstanceOf(RunRequestInvalid);
      expect(runtimes().every((runtime) => runtime.disposed())).toBe(true);
    });

    it('reports an ended run and records it without preparing or starting a sandbox', async () => {
      const { run, saveRun, sandbox, runtimes, jigDirectory } = await setup();
      const state = await saveRun({ phase: 'done' });

      const report = unwrap(await run({ run: { resume: state.runId } }));

      expect(report).toEqual({ state, status: 'done' });
      expect(sandbox.checkCredentials).not.toHaveBeenCalled();
      expect(sandbox.openScope).not.toHaveBeenCalled();
      expect((await jigDirectory()).map(([file]) => file)).toContain(
        path.join(state.runId, 'state', 'result.json'),
      );
      expect(runtimes()[0]?.disposed()).toBe(true);
    });

    it('reports an ended run from whichever store implementation its runtime supplies', async () => {
      const store = new InMemoryRunStore();
      const state = aRunState({ phase: 'done' });
      unwrap(await store.save(state));
      const { run, repoRoot, sandbox } = await setup({ runStores: catalogOver(store) });

      const report = unwrap(await run({ run: { resume: state.runId } }));

      expect(report).toEqual({ state, status: 'done' });
      expect(sandbox.openScope).not.toHaveBeenCalled();
      expect(unwrap(await new LocalRunStore(repoRoot).load(state.runId))).toBeUndefined();
    });

    it('resumes a run from the custom store module the config names', async () => {
      const state = aRunState({ phase: 'done' });
      const storeModule = `${faker.string.uuid()}.mjs`;
      const { run, repoRoot, writeFileInRepository } = await setup({
        configSource: new InMemoryConfigSource({ json: { runStores: [storeModule] } }),
      });
      await writeFileInRepository(
        storeModule,
        `export default () => ({ load: async () => (${JSON.stringify(state)}), save: async () => {} });`,
      );

      const report = unwrap(await run({ run: { resume: state.runId } }));

      expect(report.state).toEqual(state);
      expect(unwrap(await new LocalRunStore(repoRoot).load(state.runId))).toBeUndefined();
    });

    it('refuses a directory below the repository root before building anything for the run', async () => {
      const { run, openRuntime } = await setup({ startInSubdirectory: true });

      const result = await run({ run: { resume: runId() } });

      expect(result.isErr() && result.error).toBeInstanceOf(RepositoryInvalid);
      expect(openRuntime).not.toHaveBeenCalled();
    });

    it('refuses a run another process holds without opening a sandbox, and releases what it built', async () => {
      const { run, repoRoot, sandbox, runtimes } = await setup();
      const id = runId();
      const release = unwrap(await lockRun(repoRoot, id));

      const result = await run({ run: { resume: id } });
      await release();

      expect(result.isErr() && result.error).toBeInstanceOf(RunInProgress);
      expect(sandbox.openScope).not.toHaveBeenCalled();
      expect(runtimes()[0]?.disposed()).toBe(true);
    });

    it('hands the runtime the agents of the preset the operator picks at a bare --preset', async () => {
      const preset = presetName();
      const reviewer = { provider: 'claude', model: faker.word.noun() };
      const presetSource = new InMemoryPresetSource();
      presetSource.put(0, preset, { reviewer });
      const { run, saveRun, openRuntime, askForPreset, log } = await setup({
        presetSource,
        pick: { kind: 'preset', name: preset },
      });
      const state = await saveRun({ phase: 'done' });

      unwrap(await run({ run: { resume: state.runId }, preset: { kind: 'ask' } }));

      expect(askForPreset.mock.calls[0]?.[0].map(({ name }) => name)).toEqual([preset]);
      expect(openRuntime.mock.calls[0]?.[0].config.reviewer).toEqual(reviewer);
      expect(log.info).toHaveBeenCalledWith({ preset }, expect.any(String));
    });

    it('hands the runtime the project config untouched when the operator picks none', async () => {
      const reviewer = { provider: 'claude', model: faker.word.noun() };
      const presetSource = new InMemoryPresetSource();
      presetSource.put(0, presetName(), {
        reviewer: { provider: 'codex', model: faker.word.noun() },
      });
      const { run, saveRun, openRuntime, log } = await setup({
        configSource: new InMemoryConfigSource({ json: { reviewer } }),
        presetSource,
        pick: { kind: 'none' },
      });
      const state = await saveRun({ phase: 'done' });

      unwrap(await run({ run: { resume: state.runId }, preset: { kind: 'ask' } }));

      expect(openRuntime.mock.calls[0]?.[0].config.reviewer).toEqual(reviewer);
      expect(log.info).not.toHaveBeenCalled();
    });

    it('applies the picked preset over the config file it was given and hands the runtime that file', async () => {
      const preset = presetName();
      const reviewer = { provider: 'claude', model: faker.word.noun() };
      const configPath = `${faker.string.uuid()}.json`;
      const presetSource = new InMemoryPresetSource();
      presetSource.put(0, preset, { reviewer });
      const { run, repoRoot, saveRun, openRuntime, writeFileInRepository } = await setup({
        configFromRepository: true,
        presetSource,
        pick: { kind: 'preset', name: preset },
      });
      await writeFileInRepository(configPath, JSON.stringify({ mergeMode: 'auto' }));
      const state = await saveRun({ phase: 'done' });

      unwrap(await run({ run: { resume: state.runId }, preset: { kind: 'ask' }, configPath }));

      const request = openRuntime.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        repoRoot,
        configPath,
        config: { mergeMode: 'auto', reviewer },
      });
      expect(request?.configSource.name).toBe(configPath);
    });

    it('stops before building anything when the operator picks no preset', async () => {
      const presetSource = new InMemoryPresetSource();
      presetSource.put(0, presetName(), {});
      const { run, openRuntime, askForPreset } = await setup({ presetSource });

      const result = await run({ run: { resume: runId() }, preset: { kind: 'ask' } });

      expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
      expect(askForPreset).toHaveBeenCalledTimes(1);
      expect(openRuntime).not.toHaveBeenCalled();
    });
  });

  async function setup(
    input: {
      environment?: Record<string, string>;
      startInSubdirectory?: boolean;
      savedCredentials?: ReturnType<RepositorySources['readSavedCredentials']>;
      configSource?: InMemoryConfigSource;
      configFromRepository?: boolean;
      presetSource?: InMemoryPresetSource;
      pick?: PresetPick;
      runStores?: RunStoreCatalog;
    } = {},
  ) {
    const repo = { dir: await tempDirectory('jig-repo-') };
    const real = repositorySourcesAt(repo.dir);
    const configSource = input.configSource ?? new InMemoryConfigSource({ json: {} });
    const sources = {
      ensureRepositoryRoot: real.ensureRepositoryRoot,
      readSavedCredentials: vi.fn(
        input.savedCredentials ? () => input.savedCredentials! : real.readSavedCredentials,
      ),
      configSourceFor: vi.fn(
        input.configFromRepository ? real.configSourceFor : () => configSource,
      ),
      presetSourceFor: vi.fn(() => input.presetSource ?? new InMemoryPresetSource()),
    } satisfies RepositorySources;
    const records = mock<RunRecords>({
      metricsSummary: vi.fn().mockReturnValue(Result.ok(aMetricsSummary())),
      documents: vi.fn().mockReturnValue([]),
    });
    const cwd = input.startInSubdirectory ? await subdirectoryOf(repo.dir) : repo.dir;
    const context = () => operationContextIn(cwd, input.environment);
    const sandbox = mock<RunSandbox>({
      checkCredentials: vi.fn(() =>
        Result.err(new SandboxCredentialsInvalid({ message: faker.lorem.sentence() })),
      ),
    });
    const log = mock<RunLog>();
    const built: ReturnType<typeof localRunRuntime>[] = [];
    const openRuntime = vi.fn((request: RuntimeRequest) => {
      const opened = localRunRuntime(request, {
        sandbox,
        log,
        startingPoint: async () =>
          Result.ok({ baseBranch: 'main', startingCommit: faker.git.commitSha() }),
      });
      built.push(opened);
      const { runtime } = opened;
      return input.runStores
        ? { ...runtime, run: { ...runtime.run, runStores: input.runStores } }
        : runtime;
    });
    const run: JigOperations['run'] = (runInput) =>
      startOrResumeRun({ ...sources, context, openRuntime, askForPreset }, runInput);
    const status: JigOperations['status'] = (statusInput) =>
      readRunStatus(
        {
          ...sources,
          context,
          runRecordsAt: () => records,
          runStoresAt: (repoRoot) => input.runStores ?? new RepositoryRunStores(repoRoot),
        },
        statusInput,
      );
    const askForPreset = vi.fn(async (_presets: Preset[]) => input.pick);
    return {
      repoRoot: repo.dir,
      sources,
      records,
      sandbox,
      openRuntime,
      askForPreset,
      log,
      runtimes: () => built,
      run: (runInput: Omit<RunInput, 'logFormat'>) => run({ ...runInput, logFormat: 'json' }),
      writeFileInRepository: (name: string, contents: string) =>
        writeFile(path.join(repo.dir, name), contents),
      status,
      presets: () => listPresets({ ...sources, context }),
      saveRun: async (overrides: Parameters<typeof aRunState>[0] = {}) => {
        const state = aRunState(overrides);
        unwrap(await new LocalRunStore(repo.dir).save(state));
        return state;
      },
      jigDirectory: () => filesUnder(path.join(repo.dir, '.jig')),
    };
  }
});

/** Every store name the config or the operation asks for resolves to `store`. */
function catalogOver(store: InMemoryRunStore): RunStoreCatalog {
  return { storeNamed: async () => Result.ok(store), combined: () => store };
}

async function subdirectoryOf(directory: string) {
  const subdirectory = path.join(directory, faker.word.noun());
  await mkdir(subdirectory);
  return subdirectory;
}

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
