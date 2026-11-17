import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import {
  acceptedRequest,
  acceptRequest,
  type CommentIdentity,
  commentReceipt,
  emptyOrchestration,
  pullRequestReceipt,
  withComment,
  withPullRequest,
} from './orchestration-state.js';

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

  function setup() {
    return {
      state: emptyOrchestration(),
      key: faker.string.uuid(),
      request: { runId: runId(), title: faker.lorem.sentence(), text: faker.lorem.paragraph() },
    };
  }
});
