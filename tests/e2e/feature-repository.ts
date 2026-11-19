import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { z } from 'zod';

import { BASE_DOCKERFILE } from '../../src/adapters/sandbox-image/image-recipe.js';
import type { AgentChoice } from '../../src/config/agent-policy.js';
import type { AgentRole } from '../../src/domain/agent-role.js';
import { runStateSchema } from '../../src/domain/run-state.js';

/** Runs the fixture's own tests; the pipeline verifies with it and the spec checks with it. */
export const FEATURE_TEST_COMMAND = 'node --test --test-reporter=tap summary.test.mjs';

export const FEATURE_FIXTURE = fileURLToPath(new URL('./fixtures/feature/', import.meta.url));

const FIXTURE_FILES = ['summary.mjs', 'summary.test.mjs', 'request.md'];

const resultSchema = z.object({
  status: z.string(),
  phase: z.string(),
  complete: z.boolean(),
  blockedReason: z.string().optional(),
});

const metricSchema = z.object({ kind: z.string(), outcome: z.string().optional() });

/**
 * A fresh git repository on `main` holding the feature fixture — an unimplemented
 * `summary.mjs` and the tests it fails — plus the sandbox recipe and an jig config that
 * runs unattended with the given agents.
 */
export async function createFeatureRepository(agents: Record<AgentRole, AgentChoice>) {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'jig-feature-e2e-')));
  await copyFixture(repo);
  await writeSandboxRecipe(repo);
  await writeFile(path.join(repo, '.gitignore'), '.jig/\n');
  await writeJson(repo, 'package.json', { name: 'feature-e2e', private: true, type: 'module' });
  await writeJson(repo, 'jig.config.json', {
    ...agents,
    mergeMode: 'auto',
    designGate: 'auto',
    commitSigning: 'skip',
    reviewCycleCap: 2,
    agentUpdates: 'off',
    agentIdleTimeoutSeconds: 120,
    verifyCommand: FEATURE_TEST_COMMAND,
  });
  await commitEverything(repo);
  return repo;
}

/** Runs the fixture tests in the sandbox image, offline and read-only, so nothing in `repo` can change. */
export function runFeatureTests(repo: string, image: string, cancelSignal: AbortSignal) {
  const [entrypoint, ...args] = FEATURE_TEST_COMMAND.split(' ');
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
      entrypoint,
      image,
      ...args,
    ],
    { reject: false, timeout: 30_000, cancelSignal },
  );
}

/** What a run left under `.jig/<runId>/state/`: its result, saved state, documents and the step outcomes it recorded. */
export async function readRunOutcome(repo: string, runId: string) {
  const directory = path.join(repo, '.jig', runId, 'state');
  const read = (name: string) => readFile(path.join(directory, name), 'utf8');
  return {
    result: resultSchema.parse(JSON.parse(await read('result.json'))),
    state: runStateSchema.parse(JSON.parse(await read('run.json'))),
  };
}

export async function readRunRecord(repo: string, runId: string) {
  const directory = path.join(repo, '.jig', runId, 'state');
  const read = (name: string) => readFile(path.join(directory, name), 'utf8');
  return {
    documents: {
      design: await read('design.md'),
      plan: await read('plan.md'),
      pullRequestDescription: await read('PR_DESCRIPTION.md'),
    },
    stepOutcomes: (await read('metrics.jsonl'))
      .trim()
      .split('\n')
      .map((line) => metricSchema.parse(JSON.parse(line)))
      .filter((record) => record.kind === 'step')
      .map((record) => record.outcome),
  };
}

async function copyFixture(repo: string) {
  for (const name of FIXTURE_FILES) {
    await writeFile(path.join(repo, name), await readFile(path.join(FEATURE_FIXTURE, name)));
  }
}

async function writeSandboxRecipe(repo: string) {
  await mkdir(path.join(repo, '.sandcastle'));
  await writeFile(path.join(repo, '.sandcastle/Dockerfile'), BASE_DOCKERFILE);
  await writeFile(path.join(repo, '.sandcastle/.gitignore'), 'worktrees/\nlogs/\n.env\n');
}

function writeJson(repo: string, name: string, content: object) {
  return writeFile(path.join(repo, name), JSON.stringify(content, null, 2));
}

async function commitEverything(repo: string) {
  const git = simpleGit(repo);
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.name', 'jig e2e');
  await git.addConfig('user.email', 'e2e@example.invalid');
  await git.addConfig('commit.gpgsign', 'false');
  await git.add('.');
  await git.commit('Initialize failing feature fixture');
}
