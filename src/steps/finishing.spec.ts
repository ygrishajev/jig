import { faker } from '@faker-js/faker';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  aFeaturePlan,
  aFinalCheckResult,
  aRunStateIn,
  aSlice,
  runSettings,
} from '../../tests/support/builders.js';
import { type AgentScript, FakeAgentSession } from '../../tests/support/fakes.js';
import type { RunState } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { RunStep } from '../flow/define-flow.js';
import { AgentRunFailed } from '../ports/agent-session.js';
import { type Workspace } from '../ports/workspace.js';
import { describePullRequest } from './finishing.js';

describe('describePullRequest', () => {
  it("fills the repository's own pull request template", async () => {
    const template = `## ${faker.word.noun()}\n\n<!-- ${faker.lorem.sentence()} -->`;
    const body = faker.lorem.paragraphs();
    const { run, agent, writeRepoFile } = setup({ describer: { output: { body } } });
    writeRepoFile('.github/pull_request_template.md', template);

    const outcome = (await run(describePullRequest)).unwrap();

    expect(agent.calls[0].prompt).toContain(template);
    expect(outcome.type === 'described' && outcome.body.startsWith(body)).toBe(true);
  });

  it('falls back to its own description when the describer fails', async () => {
    const plan = aFeaturePlan();
    const { run } = setup({
      describer: { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) },
      state: { plan },
    });

    const outcome = (await run(describePullRequest)).unwrap();

    expect(outcome.type === 'described' && outcome.body).toContain(plan.summary);
  });

  it('reports what jig verified in the description the describer filled in', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { run } = setup({
      describer: { output: { body: faker.lorem.paragraphs() } },
      settings: runSettings({ verifyCommand }),
      state: {
        slices: [
          aSlice({ order: 0, status: 'approved', verification: { command: verifyCommand } }),
        ],
      },
    });

    const outcome = (await run(describePullRequest)).unwrap();

    expect(outcome.type === 'described' && outcome.body).toContain('### Verification by jig');
    expect(outcome.type === 'described' && outcome.body).toContain(
      `\`${verifyCommand}\` passed in the sandbox on every slice (1/1).`,
    );
  });

  it('reports what jig verified in its own description when the describer fails', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { run } = setup({
      describer: { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) },
      settings: runSettings({ verifyCommand }),
      state: {
        slices: [
          aSlice({ order: 0, status: 'approved', verification: { command: verifyCommand } }),
        ],
      },
    });

    const outcome = (await run(describePullRequest)).unwrap();

    expect(outcome.type === 'described' && outcome.body).toContain('### Verification by jig');
    expect(outcome.type === 'described' && outcome.body).toContain(
      `\`${verifyCommand}\` passed in the sandbox on every slice (1/1).`,
    );
  });

  it('keeps the reviewer feedback of a slice that did not get approved', async () => {
    const lastFeedback = faker.lorem.sentence();
    const { run } = setup({
      describer: { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) },
      state: { slices: [aSlice({ status: 'stuck', lastFeedback })] },
    });

    const outcome = (await run(describePullRequest)).unwrap();

    expect(outcome.type === 'described' && outcome.body).toContain(`> ${lastFeedback}`);
  });

  it('gives the describer the persisted final-check result to state as fact', async () => {
    const command = `npm run ${faker.word.verb()}`;
    const gap = faker.lorem.sentence();
    const finalCheck = aFinalCheckResult({
      verified: false,
      command,
      fulfilled: false,
      gaps: [gap],
      round: 2,
    });
    const { run, agent } = setup({
      describer: { output: { body: faker.lorem.paragraphs() } },
      state: { finalCheck },
    });

    await run(describePullRequest);

    expect(agent.calls[0].prompt).toContain(`Round completed: ${finalCheck.round}`);
    expect(agent.calls[0].prompt).toContain(
      `\`${command}\` failed in the sandbox for the run branch.`,
    );
    expect(agent.calls[0].prompt).toContain(`1. ${gap}`);
  });

  it('reports the whole-run findings in its own description when the describer fails', async () => {
    const command = `npm run ${faker.word.verb()}`;
    const gap = faker.lorem.sentence();
    const { run } = setup({
      describer: { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) },
      state: {
        finalCheck: aFinalCheckResult({
          verified: false,
          command,
          fulfilled: false,
          gaps: [gap],
          round: 2,
        }),
      },
    });

    const outcome = (await run(describePullRequest)).unwrap();

    expect(outcome.type === 'described' && outcome.body).toContain('### Deviations by jig');
    expect(outcome.type === 'described' && outcome.body).toContain(
      `\`${command}\` failed in the sandbox for the run branch.`,
    );
    expect(outcome.type === 'described' && outcome.body).toContain(`1. ${gap}`);
  });

  it('reports the whole-run findings even when the template has no deviations section', async () => {
    const gap = faker.lorem.sentence();
    const command = `npm run ${faker.word.verb()}`;
    const template = `## ${faker.word.noun()}\n\n<!-- ${faker.lorem.sentence()} -->`;
    const { run, writeRepoFile } = setup({
      describer: { output: { body: faker.lorem.paragraphs() } },
      state: {
        finalCheck: aFinalCheckResult({
          verified: false,
          command,
          fulfilled: false,
          gaps: [gap],
          round: 2,
        }),
      },
    });
    writeRepoFile('.github/pull_request_template.md', template);

    const outcome = (await run(describePullRequest)).unwrap();

    expect(outcome.type === 'described' && outcome.body).toContain('### Deviations by jig');
    expect(outcome.type === 'described' && outcome.body).toContain(
      `\`${command}\` failed in the sandbox for the run branch.`,
    );
    expect(outcome.type === 'described' && outcome.body).toContain(`1. ${gap}`);
  });

  function setup(input: {
    settings?: RunSettings;
    describer?: AgentScript;
    state?: Partial<Omit<RunState, 'phase'>>;
  }) {
    const agent = new FakeAgentSession(faker.system.directoryPath());
    if (input.describer) agent.script('describer', input.describer);
    const files = new Map<string, string>();
    const workspace = mock<Workspace>({
      readRepoFile: vi.fn(async (relativePath: string) => files.get(relativePath)),
    });
    return {
      agent,
      writeRepoFile: (relativePath: string, contents: string) => files.set(relativePath, contents),
      run: (step: RunStep<'describing'>) =>
        step({
          state: aRunStateIn('describing', input.state),
          ports: { agent, workspace },
          settings: input.settings ?? runSettings(),
        }),
    };
  }
});
