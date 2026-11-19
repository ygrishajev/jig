import { describe, expect, it } from 'vitest';

import {
  INVOCATION_STATUSES,
  type InvocationStatus,
  outcomeIsComplete,
} from './invocation-status.js';

describe('outcomeIsComplete', () => {
  const completion: Record<InvocationStatus, boolean> = {
    done: true,
    completed: true,
    stuck: false,
    halted: false,
    blocked: false,
  };

  it.each(INVOCATION_STATUSES)('reports whether %s finished the work', (status) => {
    expect(outcomeIsComplete(status)).toBe(completion[status]);
  });
});
