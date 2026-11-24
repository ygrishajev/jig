import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { OrchestrationStateInvalid, PublicationInProgress } from './publication-receipts.js';

describe('publication receipt failures', () => {
  it.each([OrchestrationStateInvalid, PublicationInProgress])(
    'tags %o with its own name',
    (Failure) => {
      const failure = new Failure({ message: faker.lorem.sentence() });

      expect(failure._tag).toBe(Failure.name);
    },
  );
});
