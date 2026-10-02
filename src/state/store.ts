import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getRunPaths, type RunPaths } from './run-paths.js';
import {
  runContextSchema,
  runMetaSchema,
  runPlanSchema,
  runResultSchema,
  slicesSchema,
  type RunContext,
  type RunMeta,
  type RunPlan,
  type RunResult,
  type Slice,
} from './types.js';

const CONTEXT_FILE = 'context.json';
const PLAN_FILE = 'plan.json';
const SLICES_FILE = 'slices.json';
const RUN_META_FILE = 'run-meta.json';
const RESULT_FILE = 'result.json';

export async function initializeRunState(
  repoRoot: string,
  runId: string,
  baseBranch: string,
): Promise<RunPaths> {
  const paths = getRunPaths(repoRoot, runId);
  await mkdir(paths.stateDir, { recursive: true });
  await ensureSdlcDirIsSelfIgnored(repoRoot);
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

// A target repo's own tracked .gitignore has no reason to know about .sdlc/
// (it's this tool's own scratch space, not the target project's concern), so
// without this the directory is untracked in every OTHER repo the tool runs
// against, and `isWorkingTreeClean` (which every merge relies on) never
// reports clean. Writing a self-ignoring `.sdlc/.gitignore` (a single `*`)
// solves this without ever touching the user's own tracked .gitignore.
// Written once per repo, not per run — repeated runs in the same repo just
// find it already there.
async function ensureSdlcDirIsSelfIgnored(repoRoot: string): Promise<void> {
  const sdlcGitignorePath = path.join(repoRoot, '.sdlc', '.gitignore');
  if (existsSync(sdlcGitignorePath)) return;
  await writeFile(sdlcGitignorePath, '*\n', 'utf-8');
}

export async function loadRunState(repoRoot: string, runId: string): Promise<RunPaths> {
  const paths = getRunPaths(repoRoot, runId);
  if (!existsSync(path.join(paths.stateDir, RUN_META_FILE))) {
    throw new Error(`No run found with id "${runId}" (expected state at ${paths.stateDir})`);
  }
  return paths;
}

// Used to validate a caller-supplied `--run-id` before `initializeRunState`
// would otherwise silently reuse (and overwrite) an existing run's state.
export function runIdInUse(repoRoot: string, runId: string): boolean {
  return existsSync(path.join(getRunPaths(repoRoot, runId).stateDir, RUN_META_FILE));
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

export async function readRunResult(paths: RunPaths): Promise<RunResult> {
  return runResultSchema.parse(
    JSON.parse(await readFile(path.join(paths.stateDir, RESULT_FILE), 'utf-8')),
  );
}

export async function writeRunResult(paths: RunPaths, result: RunResult): Promise<void> {
  await writeJsonFile(paths.stateDir, RESULT_FILE, runResultSchema.parse(result));
}

async function writeJsonFile(dir: string, filename: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}
