import { faker } from '@faker-js/faker';

import type { StepConfig } from '../../src/config/load-config.js';
import {
  type Preset,
  PRESET_SOURCES,
  type PresetName,
  presetNameSchema,
} from '../../src/config/presets.js';
import { byRole } from '../../src/domain/agent-role.js';
import type { CompletionEvidence } from '../../src/domain/completion-reuse.js';
import type { DesignDocs } from '../../src/domain/design-docs.js';
import {
  type DesignFinding,
  type DesignReview,
  type DesignReviewProgress,
  type FindingDisposition,
  resolveDesignReview,
} from '../../src/domain/design-review.js';
import type { Outcome } from '../../src/domain/outcome.js';
import { runIdSchema } from '../../src/domain/run-id.js';
import {
  type FeaturePlan,
  type FinalCheckResult,
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
import type {
  CheckedWork,
  GitFacts,
  WorkFacts,
  WorkObservations,
} from '../../src/domain/work-facts.js';
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

/** A slice description that opens by naming the plan steps it delivers, as the slicing prompt requires. */
export function implementingPlanSteps(...steps: number[]): string {
  const reference = steps.length === 1 ? `step ${steps[0]}` : `steps ${steps.join(', ')}`;
  return `Implements plan ${reference}. ${faker.lorem.paragraph()}`;
}

export function aSlice({
  id = sliceId(),
  title = faker.lorem.sentence(),
  description = faker.lorem.paragraph(),
  order = faker.number.int({ min: 0, max: 20 }),
  status = 'pending',
  reviewCycles = 0,
  hookFailures = 0,
  verificationFailures = 0,
  emptyAttempts = 0,
  ruleFixCycles = 0,
  lastFeedback,
  feedbackHistory = [],
  commit,
  verification,
}: Partial<Slice> = {}): Slice {
  return {
    id,
    title,
    description,
    order,
    status,
    reviewCycles,
    hookFailures,
    verificationFailures,
    emptyAttempts,
    ruleFixCycles,
    lastFeedback,
    feedbackHistory,
    commit,
    verification,
  };
}

export function aFinalCheckResult({
  verified = true,
  command,
  fulfilled = true,
  gaps = [],
  round = faker.number.int({ min: 1, max: 2 }),
}: Partial<FinalCheckResult> = {}): FinalCheckResult {
  return { verified, command, fulfilled, gaps, round };
}

export function gitFacts({
  commit = faker.git.commitSha(),
  tree = faker.git.commitSha(),
  clean = true,
}: Partial<GitFacts> = {}): GitFacts {
  return { commit, tree, clean };
}

export function workFacts({
  host = gitFacts(),
  sandbox = gitFacts(),
}: Partial<WorkFacts> = {}): WorkFacts {
  return { host, sandbox };
}

export function workObservations({
  before = workFacts(),
  after = workFacts(),
}: Partial<WorkObservations> = {}): WorkObservations {
  return { before, after };
}

function sha256() {
  return faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' });
}

export function checkedWork({
  commit = faker.git.commitSha(),
  tree = faker.git.commitSha(),
}: Partial<CheckedWork> = {}): CheckedWork {
  return { commit, tree };
}

/** What a combined slice review recorded about the whole request, generated to satisfy the schema. */
export function aCompletionEvidence({
  verdict = { fulfilled: true, gaps: [] },
  command,
  settingsIdentity = sha256(),
  checked = checkedWork(),
  observed = workObservations(),
  scope = { request: sha256(), plan: sha256(), range: `${faker.git.commitSha()}..HEAD` },
}: Partial<CompletionEvidence> = {}): CompletionEvidence {
  return { verdict, command, settingsIdentity, checked, observed, scope };
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

/** A plan document with a `## Step N — <title>` heading for each of `steps`. */
export function planWithSteps(...steps: number[]): string {
  return `# Plan\n\n${steps
    .map((step) => `## Step ${step} — ${faker.lorem.sentence()}`)
    .join('\n')}\n`;
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
    ...(reached('reviewingDesign') ? { docs: designDocs() } : {}),
    ...designReviewProducedBefore(phase),
    ...(reached('merging') ? { prDescription: faker.lorem.paragraphs() } : {}),
  };
}

function designReviewProducedBefore(phase: RunPhase) {
  if (phase === 'revisingDesign') return { designReview: aFirstDesignReview() };
  if (phase === 'resolvingDesign') return { designReview: aRevisedDesignReview() };
  return {};
}

export function aDesignFinding({
  id = sliceId(),
  concern = faker.lorem.sentence(),
  failureScenario = faker.lorem.sentence(),
  evidence = [faker.lorem.sentence()],
  recommendation = faker.lorem.sentence(),
  resolution = faker.helpers.arrayElement(['correction', 'operatorDecision'] as const),
  uncertainty = faker.helpers.arrayElement(['', faker.lorem.sentence()]),
}: Partial<DesignFinding> = {}): DesignFinding {
  return { id, concern, failureScenario, evidence, recommendation, resolution, uncertainty };
}

export function aDesignReview({
  findings = [aDesignFinding()],
}: Partial<DesignReview> = {}): DesignReview {
  return { findings };
}

/** A disposition for `finding`: addressed by a change, or disputed with evidence. */
export function aDisposition(
  finding: DesignFinding,
  status: FindingDisposition['status'] = faker.helpers.arrayElement(['addressed', 'disputed']),
): FindingDisposition {
  return status === 'addressed'
    ? { findingId: finding.id, status, change: faker.lorem.sentence() }
    : {
        findingId: finding.id,
        status,
        reasoning: faker.lorem.sentence(),
        evidence: [faker.lorem.sentence()],
      };
}

/** A design review whose first pass found problems, awaiting the planner's revision. */
export function aFirstDesignReview({
  findings = [aDesignFinding()],
}: { findings?: DesignFinding[] } = {}): DesignReviewProgress {
  return { reviews: [{ findings }] };
}

/** A design review whose findings the planner has revised, awaiting the re-review. */
export function aRevisionAwaitingReReview({
  findings = [aDesignFinding()],
  reviewedDocs = designDocs(),
}: { findings?: DesignFinding[]; reviewedDocs?: DesignDocs } = {}): DesignReviewProgress {
  return {
    reviews: [{ findings }],
    revision: { reviewedDocs, dispositions: findings.map((finding) => aDisposition(finding)) },
  };
}

/** A design review through its revision and re-review, with `outstanding` left standing. */
export function aRevisedDesignReview({
  findings = [aDesignFinding()],
  outstanding = [aDesignFinding()],
}: { findings?: DesignFinding[]; outstanding?: DesignFinding[] } = {}): DesignReviewProgress {
  const revised = aRevisionAwaitingReReview({ findings });
  return { ...revised, reviews: [...revised.reviews, { findings: outstanding }] };
}

/** A run stopped after its re-review because `outstanding` still stand, saying so as a run does. */
export function aRunBlockedByDesignReview({
  outstanding = [aDesignFinding()],
}: { outstanding?: DesignFinding[] } = {}): RunState {
  const designReview = aRevisedDesignReview({ outstanding });
  const unresolved = resolveDesignReview(designReview);
  const blockedReason = unresolved.isErr() ? unresolved.error.message : undefined;
  return aRunState({ phase: 'resolvingDesign', designReview, blockedReason });
}

/** A design review that approved the design, at the first review or at the re-review. */
export function anApprovedDesignReview(): DesignReviewProgress {
  return faker.helpers.arrayElement([
    { reviews: [{ findings: [] }] },
    aRevisedDesignReview({ outstanding: [] }),
  ]);
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

export function presetName(): PresetName {
  return presetNameSchema.parse(faker.string.alpha({ length: 8, casing: 'lower' }));
}

export function aPreset({
  name = presetName(),
  source = faker.helpers.arrayElement(PRESET_SOURCES),
  path = faker.system.filePath(),
  description,
  steps = {},
}: Partial<Preset> = {}): Preset {
  return { name, source, path, description, steps };
}
