import { z } from 'zod';

import type { InvocationStatus } from './invocation-status.js';
import type { RepositoryIdentity } from './repository-identity.js';
import { runIdSchema } from './run-id.js';

/** Which findings comment a draft PR carries: one per PR, run, outcome and exact revision. */
export interface FindingsIdentity extends CommentIdentity {
  repository: RepositoryIdentity;
  pullRequest: number;
}

export interface CommentIdentity {
  runId: AcceptedRequest['runId'];
  outcome: InvocationStatus;
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

const leaseSchema = z.object({ token: z.string(), expiresAt: z.number() });

export type PublicationLease = z.infer<typeof leaseSchema>;

/** Fields added after version 1 default to empty, so state saved before them still loads. */
export const orchestrationSchema = z.object({
  version: z.literal(1),
  requests: z.record(requestSchema),
  receipts: z.record(receiptSchema),
  comments: z.record(z.string()).default({}),
  refusals: z.record(refusalSchema).default({}),
  refusalComments: z.record(z.string()).default({}),
  findingsComments: z.record(z.string()).default({}),
  owners: z.record(leaseSchema).default({}),
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
    findingsComments: {},
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

export function withFindingsComment(
  state: Orchestration,
  identity: FindingsIdentity,
  url: string,
): Orchestration {
  if (findingsCommentReceipt(state, identity)) return state;
  return {
    ...state,
    findingsComments: { ...state.findingsComments, [findingsKey(identity)]: url },
  };
}

export function findingsCommentReceipt(
  state: Orchestration,
  identity: FindingsIdentity,
): string | undefined {
  return state.findingsComments[findingsKey(identity)];
}

function findingsKey({ repository, pullRequest, ...comment }: FindingsIdentity): string {
  return `findings:${repository.owner}/${repository.repo}#${pullRequest}:${commentKey(comment)}`;
}

/** The marker a findings comment carries, so a comment whose receipt was lost can be found again. */
export function findingsMarker(identity: FindingsIdentity): string {
  return `<!-- jig:${findingsKey(identity)} -->`;
}

export function publicationLease(token: string, now: number): PublicationLease {
  return { token, expiresAt: now + OWNERSHIP_LEASE_MS };
}

/** How long a publication owner holds its lease unrenewed; a crashed job's lease lapses after this. */
export const OWNERSHIP_LEASE_MS = 15 * 60 * 1000;

/** Takes publication of `key` for `claim` unless another owner holds an unexpired lease. */
export function claimPublication(
  state: Orchestration,
  key: string,
  claim: PublicationLease,
  now: number,
): Orchestration {
  const owner = state.owners[key];
  if (owner && owner.token !== claim.token && owner.expiresAt > now) return state;
  return { ...state, owners: { ...state.owners, [key]: claim } };
}

/** Extends the lease of `claim`'s owner; a lease another job has taken stays with that job. */
export function renewPublication(
  state: Orchestration,
  key: string,
  claim: PublicationLease,
): Orchestration {
  if (!ownsPublication(state, key, claim.token)) return state;
  return { ...state, owners: { ...state.owners, [key]: claim } };
}

export function ownsPublication(state: Orchestration, key: string, token: string): boolean {
  return state.owners[key]?.token === token;
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
