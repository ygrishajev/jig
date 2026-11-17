import { describe, expect, it } from 'vitest';

import { anIssue } from '../../../tests/support/fake-github.js';
import { requestText } from './request-snapshot.js';

describe('requestText', () => {
  it('preserves the issue title, body and source in the accepted request', () => {
    const issue = anIssue();
    const text = requestText(issue);
    expect(text).toContain(issue.title);
    expect(text).toContain(issue.body);
    expect(text).toContain(issue.url);
  });
});
