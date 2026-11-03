import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { initSummary } from './sandbox.js';

describe('initSummary', () => {
  it('tells the operator to check the starter files without an agent', () => {
    expect(initSummary({ status: 'written' })).toContain('jig init --no-agent');
  });

  it('counts the attempts a verified sandbox took only when it took more than one', () => {
    const attempts = faker.number.int({ min: 2, max: 3 });

    expect(initSummary({ status: 'verified', attempts })).toContain(`${attempts} attempts`);
    expect(initSummary({ status: 'verified', attempts: 1 })).not.toContain('attempt');
  });

  it('shows why the sandbox failed, and how many attempts were spent on it', () => {
    const failure = faker.lorem.paragraph();
    const attempts = faker.number.int({ min: 2, max: 3 });

    const summary = initSummary({ status: 'failed', attempts, failure });

    expect(summary).toContain(failure);
    expect(summary).toContain(`${attempts} attempts`);
    expect(initSummary({ status: 'failed', attempts: 1, failure })).not.toContain('attempts');
  });
});
