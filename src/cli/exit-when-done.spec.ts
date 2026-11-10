import { faker } from '@faker-js/faker';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { exitWhenDone } from './exit-when-done.js';

describe('exitWhenDone', () => {
  it('exits only after every output has finished writing', async () => {
    const { outputs, events, finishWriting, done } = setup({
      outputCount: faker.number.int({ min: 1, max: 3 }),
    });

    await Promise.resolve();
    expect(events).toEqual([]);

    finishWriting();
    await done;

    expect(events).toEqual([...outputs.map((_, index) => `drained ${index}`), 'exit']);
  });

  function setup({ outputCount }: { outputCount: number }) {
    const events: string[] = [];
    const pendingWrites: Array<() => void> = [];
    const outputs = Array.from(
      { length: outputCount },
      (_, index) =>
        new Writable({
          write: (_chunk, _encoding, callback) => {
            pendingWrites.push(() => {
              events.push(`drained ${index}`);
              callback();
            });
          },
        }),
    );
    const done = exitWhenDone(outputs, () => events.push('exit'));
    const finishWriting = () => pendingWrites.forEach((finish) => finish());
    return { outputs, events, finishWriting, done };
  }
});
