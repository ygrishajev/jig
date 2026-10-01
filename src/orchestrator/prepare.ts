import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getCurrentBranch } from '../git/branch.js';
import type { InputSource } from '../strategies/input-source/types.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import {
  initializeRunState,
  readRunMeta,
  writeContext,
  writePlan,
  writeRunMeta,
  writeSlices,
} from '../state/store.js';
import { sliceIdPattern, type RunMeta, type Slice } from '../state/types.js';
import { logRun } from '../logging.js';
import {
  buildContextPrompt,
  buildDesignPrompt,
  buildFeaturePlanPrompt,
  buildSlicePlanPrompt,
} from './prompts.js';
import { readStructuredOutput, resetStructuredOutput } from './structured-output.js';

export interface PrepareOptions {
  repoRoot: string;
  inputSource: InputSource;
  provider: AgentProvider;
}

const contextOutputSchema = z.object({ classification: z.string(), repoSummary: z.string() });
const planOutputSchema = z.object({
  summary: z.string(),
  approach: z.string(),
  affectedAreas: z.array(z.string()),
});
const designAckSchema = z.object({ written: z.array(z.string()) });
const sliceOutputSchema = z
  .array(
    z.object({
      id: z
        .string()
        .min(1)
        .regex(
          sliceIdPattern,
          'slice id must be lowercase alphanumeric characters and hyphens only',
        ),
      title: z.string().min(1),
      description: z.string().min(1),
    }),
  )
  .min(1, 'slice-plan step must return at least one slice');

export function generateRunId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * A provider that exits 0 but never writes the structured-output file
 * (ENOENT), writes malformed JSON, or writes the wrong shape is the most
 * likely real-world agentic-CLI failure mode (mirrors review-step.ts's same
 * handling). Left as a bare `readStructuredOutput` call, the thrown error
 * carries none of the agent's own output, so a planning failure is
 * undiagnosable — this wraps it so the agent's raw response is always part
 * of the error.
 */
async function readStepOutput<T>(
  cwd: string,
  label: string,
  agentOutput: string,
  parse: (raw: unknown) => T,
): Promise<T> {
  try {
    return await readStructuredOutput(cwd, parse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${label} step did not produce valid structured output: ${message}\n\nAgent output:\n${agentOutput}`,
    );
  }
}

export async function prepareRun(options: PrepareOptions): Promise<RunMeta> {
  const { repoRoot, inputSource, provider } = options;
  const rawRequest = await inputSource.resolve();
  const baseBranch = await getCurrentBranch(repoRoot);
  const runId = generateRunId();
  const paths = await initializeRunState(repoRoot, runId, baseBranch);
  logRun(runId, 'planning: context…');

  // Planning steps run with cwd = repoRoot (not an empty scratch directory) so
  // the provider can actually explore the repository its own prompt asks it
  // to. The structured-output file this produces lands in repoRoot too —
  // reset before each call and never left behind (see Task 1's .gitignore).
  await resetStructuredOutput(repoRoot);
  const contextResult = await provider.run({
    cwd: repoRoot,
    prompt: buildContextPrompt(rawRequest),
  });
  if (!contextResult.success) throw new Error(`Context step failed: ${contextResult.output}`);
  const contextOutput = await readStepOutput(repoRoot, 'Context', contextResult.output, (raw) =>
    contextOutputSchema.parse(raw),
  );
  await writeContext(paths, {
    rawRequest,
    classification: contextOutput.classification,
    repoSummary: contextOutput.repoSummary,
    createdAt: new Date().toISOString(),
  });

  logRun(runId, 'planning: feature plan…');
  await resetStructuredOutput(repoRoot);
  const planResult = await provider.run({
    cwd: repoRoot,
    prompt: buildFeaturePlanPrompt(rawRequest, contextOutput.repoSummary),
  });
  if (!planResult.success) throw new Error(`Feature-plan step failed: ${planResult.output}`);
  const planOutput = await readStepOutput(repoRoot, 'Feature-plan', planResult.output, (raw) =>
    planOutputSchema.parse(raw),
  );
  await writePlan(paths, planOutput);

  const designPath = path.join(paths.stateDir, 'design.md');
  const planPath = path.join(paths.stateDir, 'plan.md');
  logRun(runId, 'planning: design…');
  await resetStructuredOutput(repoRoot);
  const designResult = await provider.run({
    cwd: repoRoot,
    prompt: buildDesignPrompt(
      rawRequest,
      contextOutput.repoSummary,
      planOutput.summary,
      planOutput.approach,
      path.relative(repoRoot, designPath),
      path.relative(repoRoot, planPath),
    ),
  });
  if (!designResult.success) throw new Error(`Design step failed: ${designResult.output}`);
  await readStepOutput(repoRoot, 'Design', designResult.output, (raw) =>
    designAckSchema.parse(raw),
  );
  await resetStructuredOutput(repoRoot);
  await assertPlanningDocsWritten(designPath, planPath);

  logRun(runId, 'planning: slice planning…');
  await resetStructuredOutput(repoRoot);
  const sliceResult = await provider.run({
    cwd: repoRoot,
    prompt: buildSlicePlanPrompt(await readFile(planPath, 'utf-8')),
  });
  if (!sliceResult.success) throw new Error(`Slice-plan step failed: ${sliceResult.output}`);
  const sliceOutput = await readStepOutput(repoRoot, 'Slice-plan', sliceResult.output, (raw) =>
    sliceOutputSchema.parse(raw),
  );
  await resetStructuredOutput(repoRoot);
  assertUniqueSliceIds(sliceOutput);

  const slices: Slice[] = sliceOutput.map((slice, order) => ({
    ...slice,
    order,
    status: 'pending',
    reviewCycles: 0,
    mergeAttempts: 0,
  }));
  await writeSlices(paths, slices);
  logRun(runId, `planned ${slices.length} slice(s)`);

  const firstSlice = [...slices].sort((a, b) => a.order - b.order)[0];
  const meta = await readRunMeta(paths);
  await writeRunMeta(paths, {
    ...meta,
    currentSliceId: firstSlice?.id ?? null,
    updatedAt: new Date().toISOString(),
  });

  return readRunMeta(paths);
}

// Nothing in sliceOutputSchema enforces id uniqueness even though the prompt
// asks for it. A duplicate id makes the reconciler get stuck: two slices
// sharing one id means the "next non-merged slice" lookup can keep landing
// back on one that's already been merged, forever.
function assertUniqueSliceIds(sliceOutput: { id: string }[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { id } of sliceOutput) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Slice-plan step returned duplicate slice id(s): ${[...duplicates].join(', ')}`,
    );
  }
}

async function assertPlanningDocsWritten(designPath: string, planPath: string): Promise<void> {
  const missing: string[] = [];
  for (const [name, filePath] of [
    ['design.md', designPath],
    ['plan.md', planPath],
  ] as const) {
    let ok = false;
    try {
      ok = (await readFile(filePath, 'utf-8')).trim().length > 0;
    } catch {
      ok = false;
    }
    if (!ok) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `Design step did not produce ${missing.join(' and ')} at the requested paths — ` +
        'expected non-empty markdown files; the run cannot be sliced without a plan.',
    );
  }
}
