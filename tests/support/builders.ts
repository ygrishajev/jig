import { faker } from '@faker-js/faker';

import type { StepConfig } from '../../src/config/load-config.js';
import { byRole } from '../../src/domain/agent-role.js';
import type { Outcome } from '../../src/domain/outcome.js';
import { runIdSchema } from '../../src/domain/run-id.js';
import {
  type DesignDocs,
  type FeaturePlan,
  type RunContext,
  type RunPhase,
  runPhaseSchema,
  type RunState,
  type RunStateIn,
  runStateSchema,
} from '../../src/domain/run-state.js';
import type { RunSettings } from '../../src/domain/settings.js';
import type { PlannedSlice, Slice } from '../../src/domain/slice.js';
import type { CommitSummary, TokenUsage } from '../../src/domain/usage.js';
import type { MetricsSummary } from '../../src/observers/metrics.js';

export function everyStepOn(step: StepConfig = { provider: 'claude' }) {
  return byRole(() => step);
}

export function sliceId() {
  return `${faker.word.verb()}-${faker.word.noun()}-${faker.string.alphanumeric({ length: 5, casing: 'lower' })}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

export function runId() {
  return runIdSchema.parse(faker.string.hexadecimal({ length: 8, casing: 'lower', prefix: '' }));
}

export function aPlannedSlice({
  id = sliceId(),
  title = faker.lorem.sentence(),
  description = faker.lorem.paragraph(),
}: Partial<PlannedSlice> = {}): PlannedSlice {
  return { id, title, description };
}

export function aSlice({
  id = sliceId(),
  title = faker.lorem.sentence(),
  description = faker.lorem.paragraph(),
  order = faker.number.int({ min: 0, max: 20 }),
  status = 'pending',
  reviewCycles = 0,
  lastFeedback,
  commit,
}: Partial<Slice> = {}): Slice {
  return { id, title, description, order, status, reviewCycles, lastFeedback, commit };
}

export function aContext({
  classification = faker.word.noun(),
  repoSummary = faker.lorem.paragraph(),
}: Partial<RunContext> = {}): RunContext {
  return { classification, repoSummary };
}

export function aFeaturePlan({
  summary = faker.lorem.sentence(),
  approach = faker.lorem.paragraph(),
  affectedAreas = [faker.system.directoryPath()],
}: Partial<FeaturePlan> = {}): FeaturePlan {
  return { summary, approach, affectedAreas };
}

export function designDocs({
  design = `# Design\n\n${faker.lorem.paragraphs(2)}`,
  plan = `# Plan\n\n## Step 1 — ${faker.lorem.sentence()}\n`,
}: Partial<DesignDocs> = {}): DesignDocs {
  return { design, plan };
}

/**
 * A run in `phase` with everything that phase guarantees generated, unless given; parsed, so a
 * spec can only build a run the store would load.
 */
export function aRunState({
  runId: id = runId(),
  revision = faker.number.int({ min: 0, max: 100 }),
  baseBranch = 'main',
  request = `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`,
  phase = 'context',
  slices = [],
  ...rest
}: Partial<Omit<RunState, 'phase'>> & { phase?: RunPhase } = {}): RunState {
  return runStateSchema.parse({
    runId: id,
    revision,
    baseBranch,
    request,
    phase,
    slices,
    ...producedBefore(phase),
    ...rest,
  });
}

/** `aRunState`, typed as a run in `phase`, for a step that needs what `phase` guarantees. */
export function aRunStateIn<P extends RunPhase>(
  phase: P,
  overrides: Partial<Omit<RunState, 'phase'>> = {},
): RunStateIn<P> {
  const state = aRunState({ ...overrides, phase });
  if (!isIn(state, phase)) throw new Error(`Built a run in ${state.phase}, not ${phase}`);
  return state;
}

function isIn<P extends RunPhase>(state: RunState, phase: P): state is RunStateIn<P> {
  return state.phase === phase;
}

function producedBefore(phase: RunPhase) {
  const reached = (since: RunPhase) =>
    runPhaseSchema.options.indexOf(phase) >= runPhaseSchema.options.indexOf(since);
  return {
    ...(reached('planning') ? { context: aContext() } : {}),
    ...(reached('designing') ? { plan: aFeaturePlan() } : {}),
    ...(reached('slicing') ? { docs: designDocs() } : {}),
    ...(reached('merging') ? { prDescription: faker.lorem.paragraphs() } : {}),
  };
}

export function runSettings({
  reviewCycleCap = 3,
  maxStepRetries = 2,
  retryDelayMs = 0,
  designGate = 'auto',
  mergeMode = 'auto',
  verifyCommand,
}: Partial<RunSettings> = {}): RunSettings {
  return { reviewCycleCap, maxStepRetries, retryDelayMs, designGate, mergeMode, verifyCommand };
}

export function aCommit({
  sha = faker.git.commitSha(),
  filesChanged = faker.number.int({ min: 1, max: 10 }),
  insertions = faker.number.int({ min: 0, max: 200 }),
  deletions = faker.number.int({ min: 0, max: 200 }),
}: Partial<CommitSummary> = {}): CommitSummary {
  return { sha, filesChanged, insertions, deletions };
}

export function anImplementation({ commit = aCommit() }: { commit?: CommitSummary } = {}): Outcome {
  return { type: 'implemented', commit };
}

export function tokenUsage({
  input = faker.number.int({ min: 0, max: 100_000 }),
  output = faker.number.int({ min: 0, max: 100_000 }),
  cacheRead = faker.number.int({ min: 0, max: 100_000 }),
  cacheWrite = faker.number.int({ min: 0, max: 100_000 }),
  reasoning = faker.number.int({ min: 0, max: 100_000 }),
}: Partial<TokenUsage> = {}): TokenUsage {
  return { input, output, cacheRead, cacheWrite, reasoning };
}

export function aMetricsSummary({
  durationMs = faker.number.int({ min: 1000, max: 3_600_000 }),
  steps = faker.number.int({ min: 1, max: 30 }),
  agentCalls = faker.number.int({ min: 1, max: 30 }),
  retries = faker.number.int({ min: 0, max: 3 }),
  reviewRounds = faker.number.int({ min: 0, max: 5 }),
  slicesCommitted = faker.number.int({ min: 0, max: 5 }),
  linesChanged = faker.number.int({ min: 0, max: 2000 }),
  costUsd = faker.number.float({ min: 0, max: 20, fractionDigits: 2 }),
  tokens = tokenUsage(),
}: Partial<MetricsSummary> = {}): MetricsSummary {
  return {
    durationMs,
    steps,
    agentCalls,
    retries,
    reviewRounds,
    slicesCommitted,
    linesChanged,
    costUsd,
    tokens,
  };
}

/** The contents of a Codex `auth.json` holding a full ChatGPT login. */
export function codexLogin(): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: faker.string.alphanumeric(40),
      id_token: faker.string.alphanumeric(40),
      refresh_token: faker.string.alphanumeric(40),
      account_id: faker.string.uuid(),
    },
    last_refresh: faker.date.recent().toISOString(),
  });
}
