import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { ZodType } from 'zod';
import { AgentOutputInvalid, AgentRunFailed } from '../../domain/errors.js';
import type {
  AgentRole,
  AgentRunInput,
  AgentSession,
  ExecResult,
} from '../../ports/agent-session.js';
import type { AgentProvider } from './types.js';

/** Where the agent leaves its structured answer, inside the worktree, until the session reads it. */
export const STRUCTURED_OUTPUT_FILE = '.sdlc-step-output.json';

/** How much of an agent's own output to carry into an error message. */
const OUTPUT_TAIL_LIMIT = 2000;

export interface DockerAgentSessionOptions {
  providers: Record<AgentRole, AgentProvider>;
  worktreePath: string;
  repoRoot: string;
}

/**
 * Runs each role's agent in a throwaway container over the run's worktree. Structured output
 * travels through a file the agent writes; it is removed before and after every call so it can
 * never be swept into a commit.
 */
export class DockerAgentSession implements AgentSession {
  constructor(private readonly options: DockerAgentSessionOptions) {}

  async run({ role, prompt }: AgentRunInput) {
    await this.runAgent(role, prompt);
  }

  async runForOutput<T>({ role, prompt, schema }: AgentRunInput & { schema: ZodType<T> }) {
    await this.removeOutputFile();
    try {
      const agentOutput = await this.runAgent(role, `${prompt}\n${outputInstruction()}`);
      return await this.parseOutputFile(schema, agentOutput);
    } finally {
      await this.removeOutputFile();
    }
  }

  async exec(command: string): Promise<ExecResult> {
    const result = await execa(command, {
      cwd: this.options.worktreePath,
      shell: true,
      reject: false,
      all: true,
    });
    return { exitCode: result.exitCode ?? 1, output: result.all ?? '' };
  }

  private async runAgent(role: AgentRole, prompt: string) {
    const { providers, worktreePath, repoRoot } = this.options;
    const result = await providers[role].run({ cwd: worktreePath, repoRoot, prompt });
    if (!result.success) {
      throw new AgentRunFailed(`The ${role} agent failed: ${tail(result.output)}`);
    }
    return result.output;
  }

  private async parseOutputFile<T>(schema: ZodType<T>, agentOutput: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.outputFile(), 'utf-8'));
    } catch (error) {
      throw new AgentOutputInvalid(
        `The agent did not leave valid JSON in ${STRUCTURED_OUTPUT_FILE}: ${reasonOf(error)}\n\nAgent output:\n${tail(agentOutput)}`,
      );
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new AgentOutputInvalid(
        `The agent's output has the wrong shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  private outputFile() {
    return path.join(this.options.worktreePath, STRUCTURED_OUTPUT_FILE);
  }

  private removeOutputFile() {
    return rm(this.outputFile(), { force: true });
  }
}

function outputInstruction() {
  return [
    'When you are completely done, write your result as a single JSON object to the file',
    `"${STRUCTURED_OUTPUT_FILE}" in the current directory. Do not wrap it in markdown`,
    'code fences and do not include any other content in that file.',
  ].join(' ');
}

function tail(text: string) {
  return text.length > OUTPUT_TAIL_LIMIT ? `…${text.slice(-OUTPUT_TAIL_LIMIT)}` : text;
}

function reasonOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
