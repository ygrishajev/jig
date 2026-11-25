import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { describeIssue } from './validation-issue.js';

describe('describeIssue', () => {
  it('names the dotted path of an issue about a field', () => {
    const message = faker.lorem.sentence();

    expect(describeIssue({ code: 'custom', path: ['nested', 0, 'field'], message })).toBe(
      `nested.0.field: ${message}`,
    );
  });

  it('gives the message alone for an issue about the whole value', () => {
    const message = faker.lorem.sentence();

    expect(describeIssue({ code: 'custom', path: [], message })).toBe(message);
  });
});
