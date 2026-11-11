import { execa } from 'execa';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { describe, expect, it, onTestFinished } from 'vitest';

import { sandboxImageName } from '../../src/app/sandbox-image.js';
import { configFileFor, loadConfig } from '../../src/config/load-config.js';
import { runIdSchema } from '../../src/domain/run-id.js';
import { runBranchFor } from '../../src/domain/run-state.js';
import { unwrap } from '../support/unwrap.js';
import {
  createFeatureRepository,
  FEATURE_FIXTURE,
  readRunOutcome,
  readRunRecord,
  runFeatureTests,
} from './feature-repository.js';
import { e2eAgents, withCodexSubscription } from './support.js';

const CLI = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const RUN_ID = runIdSchema.parse('feature-e2e');
const FEATURE_TEST_COUNT = 6;

/** Every step a feature run passes through, from reading the repository to merging onto `main`. */
const FEATURE_PIPELINE_STEPS = [
  'contextBuilt',
  'featurePlanned',
  'designWritten',
  'sliced',
  'implemented',
  'approved',
  'verified',
  'finalChecked',
  'described',
  'merged',
];

type RunRecord = Awaited<ReturnType<typeof readRunRecord>>;
type RunOutcome = Awaited<ReturnType<typeof readRunOutcome>>;
type FeatureTestRun = Awaited<ReturnType<typeof runFeatureTests>>;

describe('live feature pipeline', () => {
  it('plans, implements, reviews and verifies a request as one slice, then merges it onto main', async () => {
    const { repo, jig, featureTests } = await setup();

    await jig('build');
    expectFeatureTestsToFail(await featureTests());
    const baseline = (await simpleGit(repo).revparse(['HEAD'])).trim();

    await jig('run', 'request.md', '--id', RUN_ID, '--log-format', 'json');

    const outcome = await readRunOutcome(repo, RUN_ID);
    expectRunFinished(outcome);
    expectOneApprovedSlice(outcome);
    const run = await readRunRecord(repo, RUN_ID);
    expectRunDocumentsWritten(run);
    expectEveryPipelineStepCompleted(run);
    await expectOnlyTheImplementationMergedOntoMain(repo, baseline);
    expectFeatureTestsToPass(await featureTests());
  });

  async function setup() {
    const environment = await withCodexSubscription(process.env);
    const agents = e2eAgents(environment);
    console.log('Live E2E roles:', agents);
    const repo = await createFeatureRepository(agents);
    console.log(`E2E repository: ${repo}`);
    const controller = new AbortController();
    onTestFinished(async ({ state }) => {
      controller.abort();
      if (state === 'pass') {
        await rm(repo, { recursive: true, force: true });
        return;
      }
      console.error(`E2E artifacts retained at ${repo}`);
    });
    const image = sandboxImageName(repo, unwrap(loadConfig(configFileFor(repo))));
    return {
      repo,
      jig: async (...args: string[]) => {
        const result = await execa(process.execPath, [CLI, ...args], {
          cwd: repo,
          env: environment,
          all: true,
          reject: false,
          timeout: 15 * 60 * 1000,
          cancelSignal: controller.signal,
        });
        expect(result.failed, `jig ${args[0]} failed. Inspect the retained repository logs.`).toBe(
          false,
        );
      },
      featureTests: () => runFeatureTests(repo, image, controller.signal),
    };
  }
});

function expectFeatureTestsToFail(tests: FeatureTestRun) {
  expect(tests.exitCode, 'The baseline must fail its assertions.').toBe(1);
  expect(tests.stdout).toMatch(/ERR_ASSERTION/);
}

function expectFeatureTestsToPass(tests: FeatureTestRun) {
  expect(tests.exitCode, 'The independent feature tests failed.').toBe(0);
  expect(tests.stdout).toMatch(new RegExp(`^# tests ${FEATURE_TEST_COUNT}$`, 'm'));
  expect(tests.stdout).toMatch(new RegExp(`^# pass ${FEATURE_TEST_COUNT}$`, 'm'));
  expect(tests.stdout).toMatch(/^# fail 0$/m);
}

function expectRunFinished({ result, state }: RunOutcome) {
  expect(result, result.blockedReason ?? `Pipeline stopped at ${result.phase}.`).toMatchObject({
    status: 'done',
    phase: 'done',
    complete: true,
  });
  expect(state.phase).toBe('done');
}

function expectOneApprovedSlice({ state }: RunOutcome) {
  expect(state.slices, 'The feature must produce exactly one slice.').toHaveLength(1);
  expect(state.slices[0].status).toBe('approved');
  expect(state.slices[0].commit).toBeTruthy();
}

function expectRunDocumentsWritten({ documents }: RunRecord) {
  for (const [name, content] of Object.entries(documents)) {
    expect(content.trim(), `The run wrote no ${name}.`).not.toBe('');
  }
}

function expectEveryPipelineStepCompleted({ stepOutcomes }: RunRecord) {
  for (const step of FEATURE_PIPELINE_STEPS) {
    expect(stepOutcomes, `Pipeline did not complete ${step}.`).toContain(step);
  }
}

async function expectOnlyTheImplementationMergedOntoMain(repo: string, baseline: string) {
  const git = simpleGit(repo);
  expect((await git.branchLocal()).current).toBe('main');
  await git.raw(['merge-base', '--is-ancestor', runBranchFor(RUN_ID), 'HEAD']);
  expect(
    (await git.diff([baseline, 'HEAD', '--name-only'])).trim(),
    'Only the implementation may change.',
  ).toBe('summary.mjs');
  expect((await git.status()).isClean()).toBe(true);
  expect(await readFile(path.join(repo, 'summary.test.mjs'))).toEqual(
    await readFile(path.join(FEATURE_FIXTURE, 'summary.test.mjs')),
  );
}
