import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';

import { BASE_DOCKERFILE } from '../../src/adapters/sandbox-image/image-recipe.js';
import { sandboxImageName } from '../../src/app/sandbox-image.js';
import { loadConfig } from '../../src/config/load-config.js';
import { runStateSchema } from '../../src/domain/run-state.js';
import { e2eAgents, FEATURE_TEST_COMMAND } from './support.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/feature/', import.meta.url));
const runId = 'feature-e2e';
const resultSchema = z.object({
  status: z.string(),
  phase: z.string(),
  complete: z.boolean(),
  blockedReason: z.string().optional(),
});
const metricSchema = z.object({ kind: z.string(), outcome: z.string().optional() });

describe('live feature pipeline', () => {
  it('implements one slice with available agents, verifies it, and merges it', async () => {
    const { repo, run, verify } = await setup();
    await run(['build']);
    const before = await verify();
    expect(before.exitCode, 'The baseline must fail its assertions.').toBe(1);
    expect(before.stdout).toMatch(/ERR_ASSERTION/);
    const initial = await simpleGit(repo).revparse(['HEAD']);
    await run(['run', 'request.md', '--id', runId, '--log-format', 'json']);
    await expectCompletedRun(repo, initial.trim());
    const after = await verify();
    expect(after.exitCode, 'The independent feature tests failed.').toBe(0);
    expect(after.stdout).toMatch(/^# tests 6$/m);
    expect(after.stdout).toMatch(/^# pass 6$/m);
    expect(after.stdout).toMatch(/^# fail 0$/m);
  });

  async function setup() {
    const environment = await withCodexSubscription(process.env);
    const roles = e2eAgents(environment);
    console.log('Live E2E roles:', roles);
    const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'sdlc-feature-e2e-')));
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
    await prepareRepository(repo, roles);
    const image = sandboxImageName(repo, loadConfig(repo));
    return {
      repo,
      run: (args: string[]) => runCli(repo, environment, args, controller.signal),
      verify: () => testFeature(repo, image, controller.signal),
    };
  }
});

async function withCodexSubscription(environment: NodeJS.ProcessEnv) {
  if (environment.SDLC_CODEX_AUTH_DIR) return environment;
  const home = environment.CODEX_HOME || path.join(homedir(), '.codex');
  const text = await readFile(path.join(home, 'auth.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw new Error('Cannot read the existing Codex subscription login.');
    },
  );
  if (text === undefined) return environment;
  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    throw new Error('The existing Codex subscription login is not valid JSON.');
  }
  const auth = z
    .object({
      tokens: z.object({
        access_token: z.string().min(1),
        id_token: z.string().min(1),
        refresh_token: z.string().min(1),
        account_id: z.string().min(1),
      }),
    })
    .safeParse(stored);
  return auth.success ? { ...environment, SDLC_CODEX_AUTH_DIR: home } : environment;
}

async function prepareRepository(repo: string, roles: ReturnType<typeof e2eAgents>) {
  for (const name of ['summary.mjs', 'summary.test.mjs', 'request.md']) {
    await writeFile(path.join(repo, name), await readFile(path.join(fixture, name)));
  }
  await mkdir(path.join(repo, '.sandcastle'));
  await writeFile(path.join(repo, '.sandcastle/Dockerfile'), BASE_DOCKERFILE);
  await writeFile(path.join(repo, '.sandcastle/.gitignore'), 'worktrees/\nlogs/\n.env\n');
  await writeFile(path.join(repo, '.gitignore'), '.sdlc/\n');
  await writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'feature-e2e', private: true, type: 'module' }),
  );
  await writeFile(
    path.join(repo, 'sdlc.config.json'),
    JSON.stringify(
      {
        ...roles,
        mergeMode: 'auto',
        designGate: 'auto',
        commitSigning: 'skip',
        reviewCycleCap: 2,
        agentUpdates: 'off',
        agentIdleTimeoutSeconds: 120,
        verifyCommand: FEATURE_TEST_COMMAND,
      },
      null,
      2,
    ),
  );
  const git = simpleGit(repo);
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.name', 'sdlc e2e');
  await git.addConfig('user.email', 'e2e@example.invalid');
  await git.addConfig('commit.gpgsign', 'false');
  await git.add('.');
  await git.commit('Initialize failing feature fixture');
}

async function runCli(
  repo: string,
  environment: NodeJS.ProcessEnv,
  args: string[],
  cancelSignal: AbortSignal,
) {
  const result = await execa(process.execPath, [path.join(root, 'dist/cli/main.js'), ...args], {
    cwd: repo,
    env: environment,
    all: true,
    reject: false,
    timeout: 15 * 60 * 1000,
    cancelSignal,
  });
  expect(result.failed, `sdlc ${args[0]} failed. Inspect the retained repository logs.`).toBe(
    false,
  );
}

async function testFeature(repo: string, image: string, cancelSignal: AbortSignal) {
  return execa(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--mount',
      `type=bind,source=${repo},target=/workspace,readonly`,
      '--workdir',
      '/workspace',
      '--entrypoint',
      'node',
      image,
      '--test',
      '--test-reporter=tap',
      'summary.test.mjs',
    ],
    { reject: false, timeout: 30_000, cancelSignal },
  );
}

async function expectCompletedRun(repo: string, initial: string) {
  const directory = path.join(repo, '.sdlc', runId, 'state');
  const result = resultSchema.parse(
    JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')),
  );
  expect(result, result.blockedReason ?? `Pipeline stopped at ${result.phase}.`).toMatchObject({
    status: 'done',
    phase: 'done',
    complete: true,
  });
  const state = runStateSchema.parse(
    JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8')),
  );
  expect(state.phase).toBe('done');
  expect(state.slices, 'The feature must produce exactly one slice.').toHaveLength(1);
  expect(state.slices[0].status).toBe('approved');
  expect(state.slices[0].commit).toBeTruthy();
  for (const name of ['design.md', 'plan.md', 'PR_DESCRIPTION.md']) {
    expect((await readFile(path.join(directory, name), 'utf8')).trim(), `Missing ${name}`).not.toBe(
      '',
    );
  }
  const outcomes = new Set(
    (await readFile(path.join(directory, 'metrics.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => metricSchema.parse(JSON.parse(line)))
      .filter((record) => record.kind === 'step')
      .map((record) => record.outcome),
  );
  for (const outcome of [
    'contextBuilt',
    'featurePlanned',
    'designWritten',
    'sliced',
    'implemented',
    'approved',
    'verified',
    'described',
    'merged',
  ]) {
    expect(outcomes, `Pipeline did not complete ${outcome}.`).toContain(outcome);
  }
  const git = simpleGit(repo);
  expect((await git.branchLocal()).current).toBe('main');
  expect(
    (await git.diff([initial, 'HEAD', '--name-only'])).trim(),
    'Only the implementation may change.',
  ).toBe('summary.mjs');
  await git.raw(['merge-base', '--is-ancestor', `sdlc/run/${runId}`, 'HEAD']);
  expect((await git.status()).isClean()).toBe(true);
  expect(await readFile(path.join(repo, 'summary.test.mjs'))).toEqual(
    await readFile(path.join(fixture, 'summary.test.mjs')),
  );
}
