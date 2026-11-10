import { Result } from 'better-result';
import { execa } from 'execa';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { ZodType } from 'zod';

import {
  AgentOutputInvalid,
  type AgentRunFailed,
  type GitCommandFailed,
  SandboxUnavailable,
} from '../../src/domain/errors.js';
import type { RunEvent } from '../../src/domain/events.js';
import type { RunId } from '../../src/domain/run-id.js';
import type { RunState } from '../../src/domain/run-state.js';
import type {
  AgentRole,
  AgentRunInput,
  AgentSession,
  ExecResult,
} from '../../src/ports/agent-session.js';
import type { Clock, EventSink } from '../../src/ports/observability.js';
import type { RunStore } from '../../src/ports/run-store.js';

/**
 * What the fake agent does for one call: write files into the worktree, return structured output,
 * fail the way a real agent does (a value), or crash the way a bug does (a throw).
 */
export type AgentScript =
  | { files: Record<string, string>; deletes?: string[]; commitMessage?: string; output?: unknown }
  | { output: unknown }
  | { fail: AgentRunFailed }
  | { crash: Error };

export interface AgentCall extends AgentRunInput {
  kind: 'run' | 'runForOutput';
}

/** Plays scripted turns per role, in order, the way a real agent working in `worktreePath` would. */
export class FakeAgentSession implements AgentSession {
  readonly calls: AgentCall[] = [];
  readonly commands: string[] = [];
  private readonly queues = new Map<AgentRole, AgentScript[]>();

  constructor(
    private readonly sandboxPath: string,
    /** A `SandboxUnavailable` plays a sandbox that could not run the command at all. */
    private readonly execResult: (command: string) => ExecResult | SandboxUnavailable = () => ({
      exitCode: 0,
      output: '',
    }),
    /** The run's worktree on the host, which the real session reports and agents never touch. */
    readonly worktreePath: string = sandboxPath,
  ) {}

  script(role: AgentRole, ...turns: AgentScript[]) {
    this.queues.set(role, [...(this.queues.get(role) ?? []), ...turns]);
    return this;
  }

  async run(input: AgentRunInput): Promise<Result<void, AgentRunFailed>> {
    this.calls.push({ ...input, kind: 'run' });
    const turn = this.nextTurn(input.role);
    if ('crash' in turn) throw turn.crash;
    if ('fail' in turn) return Result.err(turn.fail);
    if ('files' in turn) await this.work(turn);
    return Result.ok();
  }

  async runForOutput<T>(
    input: AgentRunInput & { schema: ZodType<T> },
  ): Promise<Result<T, AgentRunFailed | AgentOutputInvalid>> {
    this.calls.push({ role: input.role, prompt: input.prompt, kind: 'runForOutput' });
    const turn = this.nextTurn(input.role);
    if ('crash' in turn) throw turn.crash;
    if ('fail' in turn) return Result.err(turn.fail);
    if ('files' in turn) {
      await this.work(turn);
      if (turn.output === undefined) {
        return Result.err(new AgentOutputInvalid({ message: 'The reply tagged no output' }));
      }
    }
    if (!('output' in turn)) throw new Error(`The ${input.role} turn has no output scripted`);
    const parsed = input.schema.safeParse(turn.output);
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err(new AgentOutputInvalid({ message: parsed.error.message }));
  }

  async exec(command: string): Promise<Result<ExecResult, SandboxUnavailable>> {
    this.commands.push(command);
    const result = this.execResult(command);
    return result instanceof SandboxUnavailable ? Result.err(result) : Result.ok(result);
  }

  /** Git in the fake's clone is real, the way it is in the real sandbox; only the agent is fake. */
  async execGit(args: string[]): Promise<Result<ExecResult, SandboxUnavailable>> {
    const { exitCode, stdout, stderr } = await execa('git', args, {
      cwd: this.sandboxPath,
      reject: false,
    });
    return Result.ok({
      exitCode: exitCode ?? 1,
      output: exitCode === 0 ? stdout : `${stdout}${stderr}`,
    });
  }

  async copyOut(sandboxPath: string, hostPath: string): Promise<Result<void, GitCommandFailed>> {
    await copyFile(path.join(this.sandboxPath, sandboxPath), hostPath);
    return Result.ok();
  }

  closed = false;
  failCloseWith?: SandboxUnavailable;

  async close(): Promise<Result<void, SandboxUnavailable>> {
    this.closed = true;
    return this.failCloseWith ? Result.err(this.failCloseWith) : Result.ok();
  }

  private nextTurn(role: AgentRole) {
    const turn = this.queues.get(role)?.shift();
    if (!turn) throw new Error(`The fake agent has no turn scripted for ${role}`);
    return turn;
  }

  private async work(turn: {
    files: Record<string, string>;
    deletes?: string[];
    commitMessage?: string;
  }) {
    await this.writeFiles(turn.files);
    await this.deleteFiles(turn.deletes ?? []);
    if (turn.commitMessage) await this.commit(turn.commitMessage);
  }

  private async commit(message: string) {
    await simpleGit({ baseDir: this.sandboxPath }).add('-A').commit(message);
  }

  private async writeFiles(files: Record<string, string>) {
    for (const [relativePath, contents] of Object.entries(files)) {
      const file = path.join(this.sandboxPath, relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
  }

  private async deleteFiles(paths: readonly string[]) {
    for (const relativePath of paths) {
      await rm(path.join(this.sandboxPath, relativePath));
    }
  }
}

export class InMemoryRunStore implements RunStore {
  readonly saved: RunState[] = [];

  async load(runId: RunId) {
    return Result.ok([...this.saved].reverse().find((state) => state.runId === runId));
  }

  peek(runId: RunId) {
    return this.load(runId);
  }

  async save(state: RunState) {
    this.saved.push(structuredClone(state));
    return Result.ok();
  }
}

export class RecordingEventSink implements EventSink {
  readonly events: RunEvent[] = [];

  publish(event: RunEvent) {
    this.events.push(event);
  }

  ofType<T extends RunEvent['type']>(type: T) {
    return this.events.filter(
      (event): event is Extract<RunEvent, { type: T }> => event.type === type,
    );
  }
}

export class SteppingClock implements Clock {
  private current = 0;

  constructor(private readonly stepMs = 10) {}

  now() {
    this.current += this.stepMs;
    return this.current;
  }
}
