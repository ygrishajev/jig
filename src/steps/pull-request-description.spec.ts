import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aFinalCheckResult, aRunStateIn, aSlice } from '../../tests/support/builders.js';
import type { FinalCheckResult } from '../domain/run-state.js';
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

  it('reports the completed round, verification and fulfillment of a final check that passed', () => {
    const command = `npm run ${faker.word.verb()}`;
    const { render } = setup({
      finalCheck: aFinalCheckResult({
        verified: true,
        command,
        fulfilled: true,
        gaps: [],
        round: 1,
      }),
    });

    const body = render({ verifyCommand: command });

    expect(body).toContain('### Whole-run final check (round 1)');
    expect(body).toContain(`\`${command}\` passed in the sandbox for the run branch.`);
    expect(body).toContain('The review of the whole run reported the request fulfilled.');
    expect(body).not.toContain('### Deviations by jig');
  });

  it('reports a failed whole-run verification under the deviations jig owns', () => {
    const command = `npm run ${faker.word.verb()}`;
    const { render } = setup({
      finalCheck: aFinalCheckResult({
        verified: false,
        command,
        fulfilled: true,
        gaps: [],
        round: 1,
      }),
    });

    const body = render({ verifyCommand: command });

    expect(body).toContain(
      [
        '### Deviations by jig',
        '',
        `The verify command \`${command}\` failed in the sandbox for the run branch.`,
      ].join('\n'),
    );
    expect(body).not.toContain(`1. `);
  });

  it('lists the unmet requirements the whole-run review reported under the deviations jig owns', () => {
    const firstGap = faker.lorem.sentence();
    const secondGap = faker.lorem.sentence();
    const { render } = setup({
      finalCheck: aFinalCheckResult({ fulfilled: false, gaps: [firstGap, secondGap], round: 2 }),
    });

    const body = render();

    expect(body).toContain('### Deviations by jig');
    expect(body).toContain(`1. ${firstGap}`);
    expect(body).toContain(`2. ${secondGap}`);
  });

  it('distinguishes an unconfigured whole-run verification from a failed one', () => {
    const command = `npm run ${faker.word.verb()}`;
    const { render } = setup({
      slices: [aSlice({ order: 0, status: 'approved' })],
      finalCheck: aFinalCheckResult({
        command: undefined,
        verified: true,
        fulfilled: true,
        round: 1,
      }),
    });

    const body = render({ verifyCommand: command });

    expect(body).toContain('### Whole-run final check (round 1)');
    expect(body).toContain('No verify command is configured');
    expect(body).not.toContain('passed in the sandbox');
    expect(body).not.toContain('failed in the sandbox');
    expect(body).not.toContain('### Deviations by jig');
  });

  it('reports an absent final-check result as not run', () => {
    const { render } = setup({ slices: [aSlice({ order: 0, status: 'approved' })] });

    const body = render({ verifyCommand: `npm run ${faker.word.verb()}` });

    expect(body).toContain('The whole-run final check did not run.');
    expect(body).not.toContain('(round');
    expect(body).not.toContain('### Deviations by jig');
  });

  it('reports a round-2 result the repair delivered, leaving no deviations', () => {
    const command = `npm run ${faker.word.verb()}`;
    const { render } = setup({
      finalCheck: aFinalCheckResult({
        verified: true,
        command,
        fulfilled: true,
        gaps: [],
        round: 2,
      }),
    });

    const body = render({ verifyCommand: command });

    expect(body).toContain('### Whole-run final check (round 2)');
    expect(body).toContain(`\`${command}\` passed in the sandbox for the run branch.`);
    expect(body).not.toContain('### Deviations by jig');
  });

  it('shows the whole-run findings whichever lead the description starts with', () => {
    const command = `npm run ${faker.word.verb()}`;
    const gap = faker.lorem.sentence();
    const filled = faker.lorem.paragraphs();
    const template = `## ${faker.word.noun()}\n\n<!-- ${faker.lorem.sentence()} -->`;
    const { render } = setup({
      finalCheck: aFinalCheckResult({
        verified: false,
        command,
        fulfilled: false,
        gaps: [gap],
        round: 2,
      }),
    });

    for (const body of [render({ filled }), render({ template }), render()]) {
      expect(body).toContain('### Deviations by jig');
      expect(body).toContain(`\`${command}\` failed in the sandbox for the run branch.`);
      expect(body).toContain(`1. ${gap}`);
    }
  });

  it('reports the whole-run check between the per-slice verification and the deviations', () => {
    const command = `npm run ${faker.word.verb()}`;
    const { render } = setup({
      finalCheck: aFinalCheckResult({
        verified: false,
        command,
        fulfilled: false,
        gaps: [faker.lorem.sentence()],
        round: 2,
      }),
    });

    const body = render({ verifyCommand: command });

    const perSlice = body.indexOf('### Verification by jig');
    const wholeRun = body.indexOf('### Whole-run final check');
    const deviations = body.indexOf('### Deviations by jig');
    expect(perSlice).toBeLessThan(wholeRun);
    expect(wholeRun).toBeLessThan(deviations);
    expect(deviations).toBeLessThan(body.indexOf('<details>'));
  });

  function setup(input: { slices?: Slice[]; finalCheck?: FinalCheckResult } = {}) {
    const state = aRunStateIn('describing', { slices: input.slices, finalCheck: input.finalCheck });
    const render = (lead: { filled?: string; template?: string; verifyCommand?: string } = {}) =>
      renderPullRequest(state, lead);
    return { render, state };
  }
});
