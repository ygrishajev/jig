import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { runId } from '../../tests/support/builders.js';
import {
  acceptedRequest,
  acceptRequest,
  claimPublication,
  type CommentIdentity,
  commentMarker,
  commentReceipt,
  emptyOrchestration,
  findingsCommentReceipt,
  type FindingsIdentity,
  findingsMarker,
  orchestrationSchema,
  OWNERSHIP_LEASE_MS,
  ownsPublication,
  publicationLease,
  pullRequestReceipt,
  refusalCommentReceipt,
  refusalMarker,
  refusalOf,
  releasePublication,
  withComment,
  withFindingsComment,
  withPullRequest,
  withRefusal,
  withRefusalComment,
} from './orchestration.js';

describe('orchestration state', () => {
  it('finds a request only after it is accepted', () => {
    const { state, key, request } = setup();
    expect(acceptedRequest(state, key)).toBeUndefined();
    expect(acceptedRequest(acceptRequest(state, key, request), key)).toEqual(request);
  });

  it('keeps the first accepted request', () => {
    const { state, key, request } = setup();
    const accepted = acceptRequest(state, key, request);
    expect(
      acceptRequest(accepted, key, { ...request, text: faker.lorem.paragraph() }).requests[key],
    ).toEqual(request);
    expect(state.requests).toEqual({});
  });

  it('records PRs independently from comments for each outcome and revision', () => {
    const { state, key, request } = setup();
    const pr = { number: faker.number.int({ min: 1 }), url: faker.internet.url() };
    const identity: CommentIdentity = {
      runId: request.runId,
      outcome: 'stuck',
      revision: faker.git.commitSha(),
    };
    expect(commentReceipt(state, identity)).toBeUndefined();
    const published = withPullRequest(state, key, pr);
    expect(pullRequestReceipt(published, key)).toEqual(pr);
    const url = faker.internet.url();
    const commented = withComment(published, identity, url);
    expect(commentReceipt(commented, identity)).toBe(url);
    expect(
      commentReceipt(commented, { ...identity, revision: faker.git.commitSha() }),
    ).toBeUndefined();
    expect(commentReceipt(commented, { ...identity, outcome: 'blocked' })).toBeUndefined();
    expect(commentReceipt(commented, { ...identity, runId: runId() })).toBeUndefined();
    const next = { ...identity, revision: faker.git.commitSha() };
    const nextUrl = faker.internet.url();
    const revised = withComment(commented, next, nextUrl);
    expect(commentReceipt(revised, next)).toBe(nextUrl);
    expect(commentReceipt(revised, identity)).toBe(url);
    expect(withComment(commented, identity, faker.internet.url())).toBe(commented);
    expect(withPullRequest(commented, key, { ...pr, url: faker.internet.url() })).toBe(commented);
  });

  it('loads state saved before refusals and ownership were recorded', () => {
    const { key, request } = setup();
    const legacy = { version: 1, requests: { [key]: request }, receipts: {} };

    expect(orchestrationSchema.parse(legacy)).toEqual({
      ...emptyOrchestration(),
      requests: { [key]: request },
    });
  });

  it('keeps the first refusal of a revision and its comment apart from status comments', () => {
    const { state, key, request } = setup();
    const revision = faker.git.commitSha();
    const refusal = { runId: request.runId, revision, paths: [faker.system.filePath()] };
    const refused = withRefusal(state, key, refusal);
    const url = faker.internet.url();
    const commented = withRefusalComment(refused, key, revision, url);

    expect(refusalOf(refused, key, revision)).toEqual(refusal);
    expect(withRefusal(refused, key, { ...refusal, paths: [faker.system.filePath()] })).toBe(
      refused,
    );
    expect(refusalOf(refused, key, faker.git.commitSha())).toBeUndefined();
    expect(refusalCommentReceipt(commented, key, revision)).toBe(url);
    expect(withRefusalComment(commented, key, revision, faker.internet.url())).toBe(commented);
    expect(refusalCommentReceipt(commented, key, faker.git.commitSha())).toBeUndefined();
    expect(commented.comments).toEqual({});
  });

  it('records a findings comment per PR, run, outcome and revision, apart from status comments', () => {
    const { state, request } = setup();
    const identity: FindingsIdentity = {
      repository: { owner: faker.internet.username(), repo: faker.string.alpha(10) },
      pullRequest: faker.number.int({ min: 1 }),
      runId: request.runId,
      outcome: 'stuck',
      revision: faker.git.commitSha(),
    };
    const url = faker.internet.url();
    const status = withComment(state, identity, faker.internet.url());
    expect(findingsCommentReceipt(status, identity)).toBeUndefined();

    const commented = withFindingsComment(status, identity, url);

    expect(findingsCommentReceipt(commented, identity)).toBe(url);
    expect(withFindingsComment(commented, identity, faker.internet.url())).toBe(commented);
    for (const other of [
      { ...identity, pullRequest: identity.pullRequest + 1 },
      { ...identity, repository: { ...identity.repository, repo: faker.string.alpha(11) } },
      { ...identity, runId: runId() },
      { ...identity, outcome: 'blocked' as const },
      { ...identity, revision: faker.git.commitSha() },
    ]) {
      expect(findingsCommentReceipt(commented, other)).toBeUndefined();
      expect(findingsMarker(other)).not.toBe(findingsMarker(identity));
    }
    expect(findingsMarker(identity)).toBe(findingsMarker({ ...identity }));
    expect(findingsMarker(identity)).not.toBe(commentMarker(identity));
  });

  it('marks each comment with a marker unique to what it announces', () => {
    const { key, request } = setup();
    const revision = faker.git.commitSha();
    const identity: CommentIdentity = { runId: request.runId, outcome: 'stuck', revision };

    expect(commentMarker(identity)).toBe(commentMarker({ ...identity }));
    expect(commentMarker(identity)).not.toBe(commentMarker({ ...identity, outcome: 'blocked' }));
    expect(refusalMarker(key, revision)).toBe(refusalMarker(key, revision));
    expect(refusalMarker(key, revision)).not.toBe(refusalMarker(key, faker.git.commitSha()));
    expect(refusalMarker(key, revision)).not.toBe(commentMarker(identity));
  });

  it('lets one owner publish a request until its lease expires or it releases it', () => {
    const { state, key } = setup();
    const now = faker.number.int({ min: 1000, max: 100000 });
    const first = { token: faker.string.uuid(), expiresAt: now + 10 };
    const second = { token: faker.string.uuid(), expiresAt: now + 20 };
    const owned = claimPublication(state, key, first, now);

    expect(ownsPublication(owned, key, first.token)).toBe(true);
    expect(claimPublication(owned, key, second, now + 9)).toBe(owned);
    expect(ownsPublication(claimPublication(owned, key, second, now + 10), key, second.token)).toBe(
      true,
    );
    expect(releasePublication(owned, key, second.token)).toBe(owned);
    const released = releasePublication(owned, key, first.token);
    expect(ownsPublication(released, key, first.token)).toBe(false);
    expect(ownsPublication(claimPublication(released, key, second, now), key, second.token)).toBe(
      true,
    );
  });

  it('holds a fresh lease against other claims until it has gone unrenewed for the lease period', () => {
    const { state, key } = setup();
    const now = faker.number.int({ min: 1000, max: 100000 });
    const other = { token: faker.string.uuid(), expiresAt: now + 2 * OWNERSHIP_LEASE_MS };
    const owned = claimPublication(state, key, publicationLease(faker.string.uuid(), now), now);

    expect(claimPublication(owned, key, other, now + OWNERSHIP_LEASE_MS - 1)).toBe(owned);
    expect(
      ownsPublication(
        claimPublication(owned, key, other, now + OWNERSHIP_LEASE_MS),
        key,
        other.token,
      ),
    ).toBe(true);
  });

  function setup() {
    return {
      state: emptyOrchestration(),
      key: faker.string.uuid(),
      request: { runId: runId(), title: faker.lorem.sentence(), text: faker.lorem.paragraph() },
    };
  }
});
