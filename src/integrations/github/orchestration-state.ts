import { z } from 'zod';

import { runIdSchema } from '../../domain/run-id.js';
import type { EngineStatus } from '../../flow/engine.js';

export interface CommentIdentity {
  runId: AcceptedRequest['runId'];
  outcome: EngineStatus;
  revision: string;
}

const requestSchema = z.object({ runId: runIdSchema, text: z.string(), title: z.string() });

export type AcceptedRequest = z.infer<typeof requestSchema>;

const receiptSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
});

export type PullRequestReceipt = z.infer<typeof receiptSchema>;

const refusalSchema = z.object({
  runId: runIdSchema,
  revision: z.string(),
  paths: z.array(z.string()).min(1),
});

/** A revision held back from publication, with every path that made it ineligible. */
export type Refusal = z.infer<typeof refusalSchema>;

const ownershipSchema = z.object({ token: z.string(), expiresAt: z.number() });

export type PublicationOwnership = z.infer<typeof ownershipSchema>;

/** Fields added after version 1 default to empty, so state saved before them still loads. */
export const orchestrationSchema = z.object({
  version: z.literal(1),
  requests: z.record(requestSchema),
  receipts: z.record(receiptSchema),
  comments: z.record(z.string()).default({}),
  refusals: z.record(refusalSchema).default({}),
  refusalComments: z.record(z.string()).default({}),
  owners: z.record(ownershipSchema).default({}),
});

export type Orchestration = z.infer<typeof orchestrationSchema>;

export function emptyOrchestration(): Orchestration {
  return {
    version: 1,
    requests: {},
    receipts: {},
    comments: {},
    refusals: {},
    refusalComments: {},
    owners: {},
  };
}

export function acceptedRequest(state: Orchestration, key: string): AcceptedRequest | undefined {
  return state.requests[key];
}

export function acceptRequest(
  state: Orchestration,
  key: string,
  request: AcceptedRequest,
): Orchestration {
  return state.requests[key]
    ? state
    : { ...state, requests: { ...state.requests, [key]: request } };
}

export function pullRequestReceipt(
  state: Orchestration,
  key: string,
): PullRequestReceipt | undefined {
  return state.receipts[key];
}

export function withPullRequest(
  state: Orchestration,
  key: string,
  receipt: { number: number; url: string },
): Orchestration {
  if (state.receipts[key]) return state;
  return { ...state, receipts: { ...state.receipts, [key]: receipt } };
}

export function withComment(
  state: Orchestration,
  identity: CommentIdentity,
  url: string,
): Orchestration {
  if (commentReceipt(state, identity)) return state;
  return { ...state, comments: { ...state.comments, [commentKey(identity)]: url } };
}

export function commentReceipt(
  state: Orchestration,
  identity: CommentIdentity,
): string | undefined {
  return state.comments[commentKey(identity)];
}

function commentKey({ runId, outcome, revision }: CommentIdentity): string {
  return `${runId}:${outcome}:${revision}`;
}

/** The marker a status comment carries, so a comment whose receipt was lost can be found again. */
export function commentMarker(identity: CommentIdentity): string {
  return `<!-- jig:status:${commentKey(identity)} -->`;
}

export function withRefusal(state: Orchestration, key: string, refusal: Refusal): Orchestration {
  const id = refusalKey(key, refusal.revision);
  if (state.refusals[id]) return state;
  return { ...state, refusals: { ...state.refusals, [id]: refusal } };
}

function refusalKey(key: string, revision: string): string {
  return `${key}@${revision}`;
}

export function refusalOf(
  state: Orchestration,
  key: string,
  revision: string,
): Refusal | undefined {
  return state.refusals[refusalKey(key, revision)];
}

export function withRefusalComment(
  state: Orchestration,
  key: string,
  revision: string,
  url: string,
): Orchestration {
  const id = refusalKey(key, revision);
  if (state.refusalComments[id]) return state;
  return { ...state, refusalComments: { ...state.refusalComments, [id]: url } };
}

export function refusalCommentReceipt(
  state: Orchestration,
  key: string,
  revision: string,
): string | undefined {
  return state.refusalComments[refusalKey(key, revision)];
}

/** The marker a refusal comment carries, so a comment whose receipt was lost can be found again. */
export function refusalMarker(key: string, revision: string): string {
  return `<!-- jig:refusal:${refusalKey(key, revision)} -->`;
}

/** Takes publication of `key` for `claim` unless another owner holds an unexpired lease. */
export function claimPublication(
  state: Orchestration,
  key: string,
  claim: PublicationOwnership,
  now: number,
): Orchestration {
  const owner = state.owners[key];
  if (owner && owner.token !== claim.token && owner.expiresAt > now) return state;
  return { ...state, owners: { ...state.owners, [key]: claim } };
}

export function releasePublication(
  state: Orchestration,
  key: string,
  token: string,
): Orchestration {
  if (!ownsPublication(state, key, token)) return state;
  const { [key]: _released, ...owners } = state.owners;
  return { ...state, owners };
}

export function ownsPublication(state: Orchestration, key: string, token: string): boolean {
  return state.owners[key]?.token === token;
}
