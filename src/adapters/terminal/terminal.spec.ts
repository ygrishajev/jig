import { faker } from '@faker-js/faker';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { askInTerminal } from './terminal.js';

describe('askInTerminal', () => {
  it('asks on the controlling terminal when standard input carries a piped request', async () => {
    const { piped, controlling, open, close } = setup();
    const answer = faker.word.noun();
    const ask = vi.fn(async () => answer);

    const result = await askInTerminal(piped, ask, open);

    expect(result).toBe(answer);
    expect(ask).toHaveBeenCalledWith(controlling);
    expect(close).toHaveBeenCalledOnce();
  });

  function setup() {
    const piped = {
      input: Object.assign(new PassThrough(), { isTTY: false }),
      output: Object.assign(new PassThrough(), { isTTY: true }),
      allowControllingInput: true,
    };
    const controlling = {
      input: Object.assign(new PassThrough(), { isTTY: true }),
      output: piped.output,
    };
    const close = vi.fn(async () => undefined);
    const open = vi.fn(async () => ({ terminal: controlling, close }));
    return { piped, controlling, open, close };
  }
});
