import { Result } from 'better-result';
import { z } from 'zod';

import {
  completionEvidenceOf,
  type WholeRequest,
  wholeRequestOf,
} from '../domain/completion-reuse.js';
import {
  AgentOutputInvalid,
  type AgentRunFailed,
  CommitRejected,
  type GitCommandFailed,
  type SandboxUnavailable,
} from '../domain/errors.js';
import { fulfillmentVerdictSchema } from '../domain/final-check.js';
import type { Outcome } from '../domain/outcome.js';
import type { ChangedFile } from '../domain/protected-paths.js';
import { protectedChanges } from '../domain/protected-paths.js';
import type { RunState } from '../domain/run-state.js';
import { type Slice, slicesInOrder } from '../domain/slice.js';
import type { SliceStep, SliceStepContext, StepPorts } from '../flow/define-flow.js';
import {
  combinedReviewPrompt,
  commitRejectedFeedback,
  implementPrompt,
  nothingChangedFeedback,
  reviewPrompt,
  verifyFailedFeedback,
} from '../prompts/slice.js';

interface ReviewedRange {
  start: string;
  changed: ChangedFile[];
}

type ReviewOutcome = Extract<
  Outcome,
  { type: 'approved' | 'changesRequested' | 'rulesFixRequested' }
>;

export const implementSlice: SliceStep = ({ state, slice, settings, ports }) =>
  Result.gen(async function* () {
    const { workspace } = ports;
    const attemptStart = yield* Result.await(workspace.headCommit());
    const reply = await ports.agent.runForOutput({
      role: 'implementer',
      prompt: implementPrompt(slice, settings.verifyCommand),
      schema: implementerReplySchema,
    });
    const message = yield* commitMessageOf(reply, slice);
    const approved = yield* Result.await(sliceStart(state, slice, ports));
    const saved = await workspace.saveWork(message, { approved });
    if (saved.isErr() && CommitRejected.is(saved.error)) {
      return Result.ok<Outcome>({
        type: 'hookRejected',
        feedback: commitRejectedFeedback(saved.error.output),
      });
    }
    yield* saved;
    const head = yield* Result.await(workspace.headCommit());
    if (head === approved) {
      return Result.ok<Outcome>({
        type: 'nothingChanged',
        feedback: nothingChangedFeedback(slice),
      });
    }
    const commit = yield* Result.await(workspace.summariseCommitsSince(attemptStart));
    return Result.ok<Outcome>({ type: 'implemented', commit });
  });

const implementerReplySchema = z.object({ commitMessage: z.string().trim().min(1) });

/**
 * The message for what the implementer left uncommitted. A reply jig cannot read must not cost
 * the work it describes, so the slice title stands in and the repository's hooks judge it.
 */
function commitMessageOf(
  reply: Result<z.infer<typeof implementerReplySchema>, AgentRunFailed | AgentOutputInvalid>,
  slice: Slice,
): Result<string, AgentRunFailed> {
  if (reply.isOk()) return Result.ok(reply.value.commitMessage);
  return AgentOutputInvalid.is(reply.error) ? Result.ok(slice.title) : Result.err(reply.error);
}

/**
 * Where a slice's commits begin: where the slice before it ended, or the run branch's fork point
 * for the first. Derived from approved work rather than read from HEAD, so an attempt resumed
 * after a crash still counts the commits the interrupted attempt left behind.
 */
async function sliceStart(
  state: RunState,
  slice: Slice,
  ports: StepPorts,
): Promise<Result<string, GitCommandFailed>> {
  const previousEnd = slicesInOrder(state.slices)
    .filter((candidate) => candidate.order < slice.order && candidate.commit)
    .at(-1)?.commit;
  return previousEnd ? Result.ok(previousEnd) : ports.workspace.forkPoint();
}

export const reviewSlice: SliceStep = (context) =>
  Result.gen(async function* () {
    const { slice, ports, state } = context;
    const start = yield* Result.await(sliceStart(state, slice, ports));
    const changed = yield* Result.await(ports.workspace.changedFilesSince(start));
    const whole = wholeRequestOf(state);
    const outcome = whole
      ? yield* Result.await(reviewTheWholeRequest(context, whole, { start, changed }))
      : yield* Result.await(reviewTheSlice(context, { start, changed }));
    return Result.ok<Outcome>(outcome);
  });

/**
 * The combined review of an eligible run: the slice's code and, in the same pass, the whole
 * request against its plan. The whole-request verdict is recorded whatever the code verdict
 * says, bound to the exact work the review saw before and after it ran.
 */
async function reviewTheWholeRequest(
  { slice, ports, settings }: SliceStepContext,
  whole: WholeRequest,
  { start, changed }: ReviewedRange,
): Promise<
  Result<Outcome, AgentRunFailed | AgentOutputInvalid | GitCommandFailed | SandboxUnavailable>
> {
  const before = await ports.workspace.collectFacts();
  if (before.isErr()) return Result.err(before.error);
  const verdict = await ports.agent.runForOutput({
    role: 'reviewer',
    prompt: combinedReviewPrompt({
      slice,
      range: `${start}..HEAD`,
      protectedChanges: protectedChanges(changed),
      request: whole.request,
      plan: whole.plan,
    }),
    schema: wholeRequestVerdictSchema,
  });
  if (verdict.isErr()) return Result.err(verdict.error);
  const after = await ports.workspace.collectFacts();
  if (after.isErr()) return Result.err(after.error);
  const completion = completionEvidenceOf({
    reviewed: whole,
    settings,
    command: slice.verification?.command,
    verdict: { fulfilled: verdict.value.fulfilled, gaps: verdict.value.gaps },
    observed: { before: before.value, after: after.value },
    range: `${start}..${after.value.host.commit}`,
  });
  return Result.ok<Outcome>({ ...outcomeOfReview(verdict.value), completion });
}

const reviewVerdictSchema = z.object({
  approved: z.boolean(),
  feedback: z.string(),
  onlyRuleFindings: z.boolean().optional(),
});

/** One reply answering both questions: the code verdict, and the request verdict beside it. */
const wholeRequestVerdictSchema = reviewVerdictSchema.extend(fulfillmentVerdictSchema.shape);

function outcomeOfReview(verdict: z.infer<typeof reviewVerdictSchema>): ReviewOutcome {
  if (verdict.approved) return { type: 'approved' };
  const type = verdict.onlyRuleFindings ? 'rulesFixRequested' : 'changesRequested';
  return { type, feedback: verdict.feedback };
}

/**
 * The ordinary slice review of a run that is not a candidate for a combined one: the slice's code
 * against its description, its recorded verification and the repository's rules — nothing else.
 */
async function reviewTheSlice(
  { slice, ports }: SliceStepContext,
  { start, changed }: ReviewedRange,
): Promise<Result<Outcome, AgentRunFailed | AgentOutputInvalid>> {
  const verdict = await ports.agent.runForOutput({
    role: 'reviewer',
    prompt: reviewPrompt(slice, `${start}..HEAD`, protectedChanges(changed)),
    schema: reviewVerdictSchema,
  });
  return verdict.map(outcomeOfReview);
}

export const verifySlice: SliceStep = async ({ settings, ports }) => {
  const command = settings.verifyCommand;
  if (!command) return Result.ok<Outcome>({ type: 'verified' });

  const before = await ports.workspace.collectFacts();
  if (before.isErr()) return Result.err(before.error);
  const ran = await ports.agent.exec(command);
  if (ran.isErr()) return Result.err(ran.error);
  const { exitCode, output } = ran.value;
  if (exitCode !== 0) {
    return Result.ok({
      type: 'verificationFailed',
      feedback: verifyFailedFeedback(command, output),
    });
  }
  const after = await ports.workspace.collectFacts();
  if (after.isErr()) return Result.err(after.error);
  return Result.ok<Outcome>({
    type: 'verified',
    command,
    observed: { before: before.value, after: after.value },
  });
};
