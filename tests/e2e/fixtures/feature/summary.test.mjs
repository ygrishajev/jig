import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeNumbers } from './summary.mjs';

const examples = [
  { input: [], expected: { count: 0, sum: 0, min: null, max: null } },
  { input: [7], expected: { count: 1, sum: 7, min: 7, max: 7 } },
  { input: [-5, 0, 8], expected: { count: 3, sum: 3, min: -5, max: 8 } },
  { input: [4, 4, 4], expected: { count: 3, sum: 12, min: 4, max: 4 } },
  { input: [9, 1, 6, -2], expected: { count: 4, sum: 14, min: -2, max: 9 } },
  { input: [-10, -3], expected: { count: 2, sum: -13, min: -10, max: -3 } },
];

for (const { input, expected } of examples) {
  test(`summarizes ${JSON.stringify(input)} without changing the input`, () => {
    assert.deepEqual(summarizeNumbers(Object.freeze(input)), expected);
  });
}
