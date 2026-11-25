import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeIssues } from './describe-issues.js';

describe('describeIssues', () => {
  it('names the field of each issue and separates them with semicolons', () => {
    const fieldMessage = faker.lorem.sentence();
    const rootMessage = faker.lorem.sentence();
    const error = new z.ZodError([
      { code: 'custom', path: ['nested', 'field'], message: fieldMessage },
      { code: 'custom', path: [], message: rootMessage },
    ]);

    expect(describeIssues(error)).toBe(`nested.field: ${fieldMessage}; ${rootMessage}`);
  });
});
