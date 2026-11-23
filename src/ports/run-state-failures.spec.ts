import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  MetricsLogCorrupt,
  RunCodeUnavailable,
  RunInProgress,
  RunStateConflict,
  RunStateInvalid,
} from './run-state-failures.js';

describe('run state failures', () => {
  it.each([
    ['blocks on a conflicting remote run', RunStateConflict, 'block'],
    ['blocks on code a saved run cannot be restored to', RunCodeUnavailable, 'block'],
    ['aborts on a saved run that does not parse', RunStateInvalid, 'fatal'],
    ['aborts while another process runs the run', RunInProgress, 'fatal'],
    ['aborts on a corrupt metrics log', MetricsLogCorrupt, 'fatal'],
  ])('%s', (_case, Failure, kind) => {
    const failure = new Failure({ message: faker.lorem.sentence() });

    expect(failure.kind).toBe(kind);
    expect(failure._tag).toBe(Failure.name);
  });
});
