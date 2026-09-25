import { randomBytes } from 'node:crypto';
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
import type { RunMeta, Slice } from '../state/types.js';
import { buildContextPrompt, buildFeaturePlanPrompt, buildSlicePlanPrompt } from './prompts.js';
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
const sliceOutputSchema = z.array(
  z.object({ id: z.string().min(1), title: z.string().min(1), description: z.string().min(1) }),
);

export function generateRunId(): string {
  return randomBytes(4).toString('hex');
}

export async function prepareRun(options: PrepareOptions): Promise<RunMeta> {
  const { repoRoot, inputSource, provider } = options;
  const rawRequest = await inputSource.resolve();
  const baseBranch = await getCurrentBranch(repoRoot);
  const runId = generateRunId();
  const paths = await initializeRunState(repoRoot, runId, baseBranch);

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
  const contextOutput = await readStructuredOutput(repoRoot, (raw) =>
    contextOutputSchema.parse(raw),
  );
  await writeContext(paths, {
    rawRequest,
    classification: contextOutput.classification,
    repoSummary: contextOutput.repoSummary,
    createdAt: new Date().toISOString(),
  });

  await resetStructuredOutput(repoRoot);
  const planResult = await provider.run({
    cwd: repoRoot,
    prompt: buildFeaturePlanPrompt(rawRequest, contextOutput.repoSummary),
  });
  if (!planResult.success) throw new Error(`Feature-plan step failed: ${planResult.output}`);
  const planOutput = await readStructuredOutput(repoRoot, (raw) => planOutputSchema.parse(raw));
  await writePlan(paths, planOutput);

  await resetStructuredOutput(repoRoot);
  const sliceResult = await provider.run({
    cwd: repoRoot,
    prompt: buildSlicePlanPrompt(planOutput.summary, planOutput.approach),
  });
  if (!sliceResult.success) throw new Error(`Slice-plan step failed: ${sliceResult.output}`);
  const sliceOutput = await readStructuredOutput(repoRoot, (raw) => sliceOutputSchema.parse(raw));
  await resetStructuredOutput(repoRoot);

  const slices: Slice[] = sliceOutput.map((slice, order) => ({
    ...slice,
    order,
    status: 'pending',
    branch: `sdlc/slice/${runId}/${slice.id}`,
    reviewCycles: 0,
    mergeAttempts: 0,
  }));
  await writeSlices(paths, slices);

  const firstSlice = [...slices].sort((a, b) => a.order - b.order)[0];
  const meta = await readRunMeta(paths);
  await writeRunMeta(paths, {
    ...meta,
    currentSliceId: firstSlice?.id ?? null,
    updatedAt: new Date().toISOString(),
  });

  return readRunMeta(paths);
}
