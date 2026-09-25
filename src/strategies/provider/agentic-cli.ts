import { execa, ExecaError } from 'execa';
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
      const success = result.exitCode === 0;
      const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
      // With `reject: false`, spawn-level failures (command not found, timeout)
      // resolve with empty stdout/stderr instead of throwing. Fall back to
      // execa's own summary so a failure is never reported with no explanation.
      const output = !success && !combinedOutput ? (result.shortMessage ?? '') : combinedOutput;
      return { success, output };
    } catch (error) {
      const output =
        error instanceof ExecaError
          ? error.shortMessage
          : error instanceof Error
            ? error.message
            : String(error);
      return { success: false, output };
    }
  }
}
