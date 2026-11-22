import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { execa } from 'execa';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { vi } from 'vitest';
import type { ZodType } from 'zod';

import type { StandardInput } from '../../src/adapters/terminal/standard-input.js';
import {
  type ConfigContents,
  ConfigNotJson,
  type ConfigSource,
  ConfigUnreadable,
  ConfigUnwritable,
} from '../../src/config/config-source.js';
import {
  type PresetEntry,
  type PresetFiles,
  type PresetName,
  type PresetRoots,
  type PresetSource,
} from '../../src/config/presets.js';
import {
  AgentOutputInvalid,
  type AgentRunFailed,
  ConfigInvalid,
  type GitCommandFailed,
  SandboxUnavailable,
} from '../../src/domain/errors.js';
import type { RunEvent } from '../../src/domain/events.js';
import type { RunId } from '../../src/domain/run-id.js';
import type { RunState } from '../../src/domain/run-state.js';
import type { TokenUsage } from '../../src/domain/usage.js';
import type {
  AgentRole,
  AgentRunInput,
  AgentSession,
  ExecResult,
} from '../../src/ports/agent-session.js';
import type { Clock, EventSink } from '../../src/ports/observability.js';
import type { RunStore } from '../../src/ports/run-store.js';
import { tokenUsage } from './builders.js';

/**
 * What the fake agent does for one call: write files into the worktree, return structured output,
 * fail the way a real agent does (a value), or crash the way a bug does (a throw). A turn may also
 * be the last its sandbox survives.
 */
export type AgentScript =
  | {
      files: Record<string, string>;
      deletes?: string[];
      commitMessage?: string;
      output?: unknown;
      takesSandboxDown?: SandboxUnavailable;
    }
  | { output: unknown; takesSandboxDown?: SandboxUnavailable }
  | { fail: AgentRunFailed }
  | { crash: Error };

export interface AgentCall extends AgentRunInput {
  kind: 'run' | 'runForOutput';
}

/** What one agent call cost, as the real session reports it from the agent's stream. */
export interface AgentUsage {
  role: AgentRole;
  costUsd: number;
  tokens: TokenUsage;
}

/** Plays scripted turns per role, in order, the way a real agent working in `worktreePath` would. */
export class FakeAgentSession implements AgentSession {
  readonly calls: AgentCall[] = [];
  readonly commands: string[] = [];
  readonly usage: AgentUsage[] = [];
  private readonly queues = new Map<AgentRole, AgentScript[]>();
  private usageReport?: { events: EventSink; runId: RunId };

  private sandboxDown?: SandboxUnavailable;

  constructor(
    private readonly sandboxPath: string,
    /**
     * A `SandboxUnavailable` plays a sandbox that could not run the command at all; the session is
     * handed back so a command can take its own container down as it ends.
     */
    private readonly execResult: (
      command: string,
      session: FakeAgentSession,
    ) => ExecResult | SandboxUnavailable | Promise<ExecResult | SandboxUnavailable> = () => ({
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

  /** Publishes each call's usage on `events`, the way the real session does for its run. */
  reportUsageTo(events: EventSink, runId: RunId) {
    this.usageReport = { events, runId };
    return this;
  }

  async run(input: AgentRunInput): Promise<Result<void, AgentRunFailed>> {
    this.calls.push({ ...input, kind: 'run' });
    const turn = this.nextTurn(input.role);
    if ('crash' in turn) throw turn.crash;
    if ('fail' in turn) return Result.err(turn.fail);
    if ('files' in turn) await this.work(turn);
    this.takeSandboxDownWith(turn);
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
    this.takeSandboxDownWith(turn);
    if (!('output' in turn)) throw new Error(`The ${input.role} turn has no output scripted`);
    const parsed = input.schema.safeParse(turn.output);
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err(new AgentOutputInvalid({ message: parsed.error.message }));
  }

  /** The sandbox this session stands in for is gone: a dead container runs neither git nor commands. */
  takeSandboxDown(failure: SandboxUnavailable): void {
    this.sandboxDown = failure;
  }

  /** A turn that ends its container: everything the sandbox is asked after it fails. */
  private takeSandboxDownWith(turn: { takesSandboxDown?: SandboxUnavailable }): void {
    if (turn.takesSandboxDown) this.takeSandboxDown(turn.takesSandboxDown);
  }

  async exec(command: string): Promise<Result<ExecResult, SandboxUnavailable>> {
    if (this.sandboxDown) return Result.err(this.sandboxDown);
    this.commands.push(command);
    const result = await this.execResult(command, this);
    return result instanceof SandboxUnavailable ? Result.err(result) : Result.ok(result);
  }

  /** Git in the fake's clone is real, the way it is in the real sandbox; only the agent is fake. */
  async execGit(args: string[]): Promise<Result<ExecResult, SandboxUnavailable>> {
    if (this.sandboxDown) return Result.err(this.sandboxDown);
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
    this.reportUsage(role);
    return turn;
  }

  private reportUsage(role: AgentRole) {
    if (!this.usageReport) return;
    const usage = {
      role,
      costUsd: faker.number.float({ max: 2, fractionDigits: 2 }),
      tokens: tokenUsage(),
    };
    this.usage.push(usage);
    this.usageReport.events.publish({
      type: 'agentUsage',
      runId: this.usageReport.runId,
      ...usage,
    });
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

export function fakeStandardInput({
  text = faker.lorem.paragraph(),
  isTerminal = false,
}: { text?: string; isTerminal?: boolean } = {}): StandardInput {
  return { isTerminal, readAll: vi.fn(async () => text) };
}

/**
 * Presets held in memory, per directory, failing where the disk would. Records the roots it was
 * given and every directory it listed and file it read, so a spec can tell what policy touched.
 */
export class FakePresetFiles implements PresetFiles {
  readonly rootsGiven: PresetRoots[] = [];
  readonly listed: string[] = [];
  readonly readFiles: string[] = [];
  private readonly contents = new Map<string, unknown>();
  private readonly unreadable = new Set<string>();
  private readonly unlistable = new Set<string>();
  private readonly unreachable = new Set<string>();

  readonly paths: Record<PresetSource, string>;

  constructor(paths: Partial<Record<PresetSource, string>> = {}) {
    this.paths = { ...distinctPresetDirectories(), ...paths };
  }

  directories(roots: PresetRoots) {
    this.rootsGiven.push(roots);
    return this.paths;
  }

  filesIn(directory: string) {
    this.listed.push(directory);
    if (this.unreachable.has(directory)) return this.failure(`unreachable ${directory}`);
    if (this.unlistable.has(directory)) return this.failure(`unlistable ${directory}`);
    const entries = [...this.contents.keys(), ...this.unreadable]
      .filter((file) => path.dirname(file) === directory)
      .map((file): PresetEntry => ({ name: path.basename(file, '.json'), path: file }));
    return Result.ok(faker.helpers.shuffle(entries));
  }

  fileFor(directory: string, name: PresetName) {
    return this.pathOf(directory, name);
  }

  isPresent(entryPath: string) {
    if (this.unreachable.has(path.dirname(entryPath))) return this.failure(entryPath);
    return Result.ok(this.contents.has(entryPath) || this.unreadable.has(entryPath));
  }

  read(filePath: string) {
    this.readFiles.push(filePath);
    if (!this.contents.has(filePath)) return this.failure(filePath);
    return Result.ok(this.contents.get(filePath));
  }

  /** Puts a preset file under any name, valid or not; returns where it is. */
  put(source: PresetSource, name: string, json: unknown) {
    const file = this.pathOf(this.paths[source], name);
    this.contents.set(file, json);
    return file;
  }

  /** A file that is present but cannot be read, like a dangling link or malformed JSON. */
  putUnreadable(source: PresetSource, name: string) {
    const file = this.pathOf(this.paths[source], name);
    this.unreadable.add(file);
    return file;
  }

  makeUnlistable(source: PresetSource) {
    this.unlistable.add(this.paths[source]);
  }

  /** Neither the directory nor anything in it can be looked at, like one under a file. */
  makeUnreachable(source: PresetSource) {
    this.unreachable.add(this.paths[source]);
  }

  private pathOf(directory: string, name: string) {
    return path.join(directory, `${name}.json`);
  }

  private failure(message: string) {
    return Result.err(new ConfigInvalid({ message }));
  }
}

function distinctPresetDirectories(): Record<PresetSource, string> {
  const root = path.join('/', faker.string.uuid());
  return {
    repository: path.join(root, 'repository'),
    home: path.join(root, 'home'),
    xdg: path.join(root, 'xdg'),
    builtin: path.join(root, 'builtin'),
  };
}

/**
 * Settings kept in memory, so config's policy is checked without a filesystem. `stored` is what
 * the last write left; `failure` makes reads or writes fail as a real destination can.
 */
export class InMemoryConfigSource implements ConfigSource {
  readonly name: string;
  readonly custom: boolean;
  stored: ConfigContents;
  private readonly failure?: 'unreadable' | 'not-json' | 'unwritable';
  readonly location = faker.system.filePath();
  readonly detail = faker.lorem.sentence();

  constructor({
    name = `${faker.word.noun()}.json`,
    custom = faker.datatype.boolean(),
    json,
    failure,
  }: {
    name?: string;
    custom?: boolean;
    json?: unknown;
    failure?: 'unreadable' | 'not-json' | 'unwritable';
  } = {}) {
    this.name = name;
    this.custom = custom;
    this.failure = failure;
    this.stored =
      json === undefined ? { kind: 'absent', detail: this.detail } : { kind: 'present', json };
  }

  read(): Result<ConfigContents, ConfigUnreadable | ConfigNotJson> {
    if (this.failure === 'unreadable') {
      return Result.err(new ConfigUnreadable({ location: this.location, detail: this.detail }));
    }
    if (this.failure === 'not-json') return Result.err(new ConfigNotJson({ detail: this.detail }));
    return Result.ok(this.stored);
  }

  async write(settings: Record<string, unknown>): Promise<Result<void, ConfigUnwritable>> {
    if (this.failure === 'unwritable') {
      return Result.err(new ConfigUnwritable({ location: this.location, detail: this.detail }));
    }
    this.stored = { kind: 'present', json: structuredClone(settings) };
    return Result.ok();
  }
}
