import type { AgentProvider, AgentRunInput, AgentRunResult } from './types.js';

export type FakeAgentHandler = (input: AgentRunInput) => Promise<AgentRunResult> | AgentRunResult;

export class FakeAgentProvider implements AgentProvider {
  constructor(private readonly handler: FakeAgentHandler) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return this.handler(input);
  }
}
