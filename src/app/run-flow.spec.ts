import { describe, expect, it } from 'vitest';

import { aRunState } from '../../tests/support/builders.js';
import { finalStatus } from '../flow/define-flow.js';
import { runFlow } from './run-flow.js';

describe('runFlow', () => {
  it('reads a run in the completed phase as finished as completed', () => {
    const completed = aRunState({ phase: 'completed' });

    expect(finalStatus(runFlow, completed)).toBe('completed');
  });
});
