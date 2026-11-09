import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aRunStateIn, aSlice } from '../../tests/support/builders.js';
import type { Slice } from '../domain/slice.js';
import { renderPullRequest } from './pull-request-description.js';

describe('renderPullRequest', () => {
  it('reports that jig ran no checks when no verify command is configured', () => {
    const passed = `npm run ${faker.word.verb()}`;
    const { render } = setup({
      slices: [
        aSlice({ order: 0, status: 'approved', verification: { command: passed } }),
        aSlice({ order: 1, status: 'stuck' }),
      ],
    });

    const body = render();

    expect(body).toContain('No verify command is configured, so jig ran no checks.');
    expect(body).not.toContain('passed in the sandbox');
  });

  it('reports the one command every approved slice passed in the sandbox', () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { render } = setup({
      slices: [
        aSlice({ order: 0, status: 'approved', verification: { command: verifyCommand } }),
        aSlice({ order: 1, status: 'approved', verification: { command: verifyCommand } }),
        aSlice({ order: 2, status: 'approved', verification: { command: verifyCommand } }),
      ],
    });

    const body = render({ verifyCommand });

    expect(body).toContain(`\`${verifyCommand}\` passed in the sandbox on every slice (3/3).`);
    expect(body).not.toContain('not verified');
  });

  it('lists each slice in order with the command it passed or why it was not verified', () => {
    const firstCommand = `npm run ${faker.word.verb()}`;
    const lastCommand = `npm run ${faker.word.verb()}`;
    const passedFirst = aSlice({
      order: 0,
      status: 'approved',
      verification: { command: firstCommand },
    });
    const stuck = aSlice({ order: 1, status: 'stuck' });
    const passedLast = aSlice({
      order: 2,
      status: 'approved',
      verification: { command: lastCommand },
    });
    const { render } = setup({ slices: [passedLast, passedFirst, stuck] });

    const body = render({ verifyCommand: `npm run ${faker.word.verb()}` });

    expect(body).toContain(
      [
        '### Verification by jig',
        '',
        `- \`${passedFirst.id}\`: \`${firstCommand}\` passed`,
        `- \`${stuck.id}\`: not verified (stuck)`,
        `- \`${passedLast.id}\`: \`${lastCommand}\` passed`,
      ].join('\n'),
    );
    expect(body).not.toContain('passed in the sandbox on every slice');
  });

  it('lists a slice that was never verified even when it was approved', () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const unverified = aSlice({ order: 0, status: 'approved' });
    const { render } = setup({
      slices: [
        unverified,
        aSlice({ order: 1, status: 'approved', verification: { command: verifyCommand } }),
      ],
    });

    const body = render({ verifyCommand });

    expect(body).toContain(`- \`${unverified.id}\`: not verified (approved)`);
    expect(body).not.toContain('passed in the sandbox on every slice');
  });

  it('puts the verification report before the collapsed agent run', () => {
    const stuck = aSlice({ order: 1, status: 'stuck' });
    const { render } = setup({
      slices: [aSlice({ order: 0, status: 'approved' }), stuck],
    });

    const body = render({ verifyCommand: `npm run ${faker.word.verb()}` });

    const report = body.indexOf('### Verification by jig');
    const collapsed = body.indexOf('<details>');
    expect(report).toBeGreaterThan(-1);
    expect(report).toBeLessThan(collapsed);
    expect(body.indexOf(`- \`${stuck.id}\`: not verified (stuck)`)).toBeLessThan(collapsed);
  });

  it('reports the verification whichever lead the description starts with', () => {
    const filled = faker.lorem.paragraphs();
    const template = `## ${faker.word.noun()}\n\n<!-- ${faker.lorem.sentence()} -->`;
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { render, state } = setup({
      slices: [aSlice({ order: 0, status: 'approved', verification: { command: verifyCommand } })],
    });

    const bodies = [
      render({ filled, verifyCommand }),
      render({ template, verifyCommand }),
      render({ verifyCommand }),
    ];

    for (const body of bodies) {
      expect(body).toContain(`\`${verifyCommand}\` passed in the sandbox on every slice (1/1).`);
    }
    expect(bodies[0].startsWith(filled)).toBe(true);
    expect(bodies[1].startsWith(template)).toBe(true);
    expect(bodies[2]).toContain(state.plan.summary);
  });

  function setup(input: { slices?: Slice[] } = {}) {
    const state = aRunStateIn('describing', { slices: input.slices });
    const render = (lead: { filled?: string; template?: string; verifyCommand?: string } = {}) =>
      renderPullRequest(state, lead);
    return { render, state };
  }
});
