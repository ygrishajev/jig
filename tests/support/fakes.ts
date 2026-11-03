import { Result } from 'better-result';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { ZodType } from 'zod';

import { AgentOutputInvalid, type AgentRunFailed } from '../../src/domain/errors.js';
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
  | { files: Record<string, string>; commitMessage?: string }
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
    readonly worktreePath: string,
    private readonly execResult: (command: string) => ExecResult = () => ({
      exitCode: 0,
      output: '',
    }),
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
    if ('files' in turn) {
      await this.writeFiles(turn.files);
      if (turn.commitMessage) await this.commit(turn.commitMessage);
    }
    return Result.ok();
  }

  async runForOutput<T>(
    input: AgentRunInput & { schema: ZodType<T> },
  ): Promise<Result<T, AgentRunFailed | AgentOutputInvalid>> {
    this.calls.push({ role: input.role, prompt: input.prompt, kind: 'runForOutput' });
    const turn = this.nextTurn(input.role);
    if ('crash' in turn) throw turn.crash;
    if ('fail' in turn) return Result.err(turn.fail);
    if (!('output' in turn)) throw new Error(`The ${input.role} turn has no output scripted`);
    const parsed = input.schema.safeParse(turn.output);
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err(new AgentOutputInvalid({ message: parsed.error.message }));
  }

  async exec(command: string) {
    this.commands.push(command);
    return this.execResult(command);
  }

  closed = false;

  async close() {
    this.closed = true;
    return Result.ok();
  }

  private nextTurn(role: AgentRole) {
    const turn = this.queues.get(role)?.shift();
    if (!turn) throw new Error(`The fake agent has no turn scripted for ${role}`);
    return turn;
  }

  private async commit(message: string) {
    await simpleGit({ baseDir: this.worktreePath }).add('-A').commit(message);
  }

  private async writeFiles(files: Record<string, string>) {
    for (const [relativePath, contents] of Object.entries(files)) {
      await writeFile(path.join(this.worktreePath, relativePath), contents);
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
