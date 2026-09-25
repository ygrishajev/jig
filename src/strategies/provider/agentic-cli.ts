import { execa } from 'execa';
import type { AgentProvider, AgentRunInput, AgentRunResult } from './types.js';

export interface AgenticCliProviderOptions {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export class AgenticCliProvider implements AgentProvider {
  constructor(private readonly options: AgenticCliProviderOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { command, args = [], timeoutMs } = this.options;
    try {
      const result = await execa(command, [...args, input.prompt], {
        cwd: input.cwd,
        timeout: timeoutMs,
        reject: false,
      });
      const output = `${result.stdout}\n${result.stderr}`.trim();
      return { success: result.exitCode === 0, output };
    } catch (error) {
      return { success: false, output: error instanceof Error ? error.message : String(error) };
    }
  }
}
