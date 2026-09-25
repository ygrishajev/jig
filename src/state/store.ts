import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getRunPaths, type RunPaths } from './run-paths.js';
import {
  runContextSchema,
  runMetaSchema,
  runPlanSchema,
  slicesSchema,
  type RunContext,
  type RunMeta,
  type RunPlan,
  type Slice,
} from './types.js';

const CONTEXT_FILE = 'context.json';
const PLAN_FILE = 'plan.json';
const SLICES_FILE = 'slices.json';
const RUN_META_FILE = 'run-meta.json';

export async function initializeRunState(
  repoRoot: string,
  runId: string,
  baseBranch: string,
): Promise<RunPaths> {
  const paths = getRunPaths(repoRoot, runId);
  await mkdir(paths.stateDir, { recursive: true });
  await writeRunMeta(paths, {
    runId,
    baseBranch,
    currentSliceId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await writeSlices(paths, []);
  return paths;
}

export async function loadRunState(repoRoot: string, runId: string): Promise<RunPaths> {
  const paths = getRunPaths(repoRoot, runId);
  if (!existsSync(path.join(paths.stateDir, RUN_META_FILE))) {
    throw new Error(`No run found with id "${runId}" (expected state at ${paths.stateDir})`);
  }
  return paths;
}

export async function readRunMeta(paths: RunPaths): Promise<RunMeta> {
  return runMetaSchema.parse(
    JSON.parse(await readFile(path.join(paths.stateDir, RUN_META_FILE), 'utf-8')),
  );
}

export async function writeRunMeta(paths: RunPaths, meta: RunMeta): Promise<void> {
  await writeJsonFile(paths.stateDir, RUN_META_FILE, runMetaSchema.parse(meta));
}

export async function readContext(paths: RunPaths): Promise<RunContext> {
  return runContextSchema.parse(
    JSON.parse(await readFile(path.join(paths.stateDir, CONTEXT_FILE), 'utf-8')),
  );
}

export async function writeContext(paths: RunPaths, context: RunContext): Promise<void> {
  await writeJsonFile(paths.stateDir, CONTEXT_FILE, runContextSchema.parse(context));
}

export async function readPlan(paths: RunPaths): Promise<RunPlan> {
  return runPlanSchema.parse(
    JSON.parse(await readFile(path.join(paths.stateDir, PLAN_FILE), 'utf-8')),
  );
}

export async function writePlan(paths: RunPaths, plan: RunPlan): Promise<void> {
  await writeJsonFile(paths.stateDir, PLAN_FILE, runPlanSchema.parse(plan));
}

export async function readSlices(paths: RunPaths): Promise<Slice[]> {
  return slicesSchema.parse(
    JSON.parse(await readFile(path.join(paths.stateDir, SLICES_FILE), 'utf-8')),
  );
}

export async function writeSlices(paths: RunPaths, slices: Slice[]): Promise<void> {
  await writeJsonFile(paths.stateDir, SLICES_FILE, slicesSchema.parse(slices));
}

async function writeJsonFile(dir: string, filename: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}
