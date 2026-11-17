import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import {
  acceptedRequest,
  acceptRequest,
  emptyOrchestration,
  hasCommented,
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

  it('records a PR and its comment independently', () => {
    const { state, key } = setup();
    const pr = { number: faker.number.int({ min: 1 }), url: faker.internet.url() };
    expect(pullRequestReceipt(state, key)).toBeUndefined();
    expect(hasCommented(state, key)).toBe(false);
    expect(withComment(state, key)).toBe(state);
    const published = withPullRequest(state, key, pr);
    expect(pullRequestReceipt(published, key)).toMatchObject(pr);
    expect(hasCommented(published, key)).toBe(false);
    const commented = withComment(published, key);
    expect(hasCommented(commented, key)).toBe(true);
    expect(withComment(commented, key)).toBe(commented);
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
