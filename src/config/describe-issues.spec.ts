import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeIssues } from './describe-issues.js';

describe('describeIssues', () => {
  it('separates field and root issues with the requested separator', () => {
    const fieldMessage = faker.lorem.sentence();
    const rootMessage = faker.lorem.sentence();
    const error = new z.ZodError([
      { code: 'custom', path: ['nested', 'field'], message: fieldMessage },
      { code: 'custom', path: [], message: rootMessage },
    ]);

    expect(describeIssues(error)).toBe(`nested.field: ${fieldMessage}; ${rootMessage}`);
    expect(describeIssues(error, '\n')).toBe(`nested.field: ${fieldMessage}\n${rootMessage}`);
  });
});
