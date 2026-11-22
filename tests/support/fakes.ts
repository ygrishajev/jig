import { faker } from '@faker-js/faker';
import { panic, Result } from 'better-result';
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
  type PresetCandidate,
  type PresetLabel,
  PresetNotFindable,
  type PresetSource,
  PresetsUnlistable,
  PresetUnreadable,
} from '../../src/config/preset-source.js';
import type { PresetName } from '../../src/config/presets.js';
import {
  AgentOutputInvalid,
  type AgentRunFailed,
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
import { aPresetLabel, tokenUsage } from './builders.js';

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
 * Presets held in memory in places of precedence order, failing where a real source can. Records
 * each place it looked in for a name, each listing and each candidate read, so a spec can tell
 * what policy touched.
 */
export class InMemoryPresetSource implements PresetSource {
  readonly places: string[];
  readonly lookedIn: string[] = [];
  readonly readLocations: string[] = [];
  listings = 0;
  private readonly held = new Map<string, HeldPreset[]>();
  private readonly unfindable = new Set<string>();
  private readonly unlistable = new Set<string>();

  constructor(placeCount = 4) {
    this.places = faker.helpers.uniqueArray(() => faker.system.directoryPath(), placeCount);
  }

  *candidatesNamed(name: PresetName) {
    for (const place of this.places) {
      this.lookedIn.push(place);
      if (this.unfindable.has(place)) {
        yield Result.err(this.failure(PresetNotFindable, place));
        return;
      }
      const found = this.heldIn(place).find((held) => held.name === name);
      if (found) yield Result.ok(this.candidateFor(found));
    }
  }

  candidates() {
    this.listings += 1;
    const unavailable = this.places.find(
      (place) => this.unfindable.has(place) || this.unlistable.has(place),
    );
    if (unavailable !== undefined) {
      return Result.err(
        this.unfindable.has(unavailable)
          ? this.failure(PresetNotFindable, unavailable)
          : this.failure(PresetsUnlistable, unavailable),
      );
    }
    return Result.ok(
      this.places.flatMap((place) =>
        [...this.heldIn(place)]
          .sort((first, second) => (first.name < second.name ? -1 : 1))
          .map((held) => this.candidateFor(held)),
      ),
    );
  }

  /** Puts a preset in the place at `rank`, under any name, valid or not; returns where it says it is. */
  put(rank: number, name: string, json: unknown): PresetLabel {
    return this.hold(rank, { name, label: aLabel(this.placeAt(rank), name), json });
  }

  /** A candidate that is present but cannot be read, like a dangling link or malformed JSON. */
  putUnreadable(rank: number, name: string): PresetLabel {
    return this.hold(rank, { name, label: aLabel(this.placeAt(rank), name), unreadable: true });
  }

  /** Nothing in the place can be looked at, like a directory under a file. */
  makeUnfindable(rank: number) {
    this.unfindable.add(this.placeAt(rank));
  }

  makeUnlistable(rank: number) {
    this.unlistable.add(this.placeAt(rank));
  }

  placeAt(rank: number): string {
    return this.places[rank] ?? panic(`No preset place ranked ${rank}`);
  }

  private hold(rank: number, preset: HeldPreset) {
    const place = this.placeAt(rank);
    this.held.set(place, [...this.heldIn(place), preset]);
    return preset.label;
  }

  private heldIn(place: string) {
    return this.held.get(place) ?? [];
  }

  private candidateFor(held: HeldPreset): PresetCandidate {
    return {
      name: held.name,
      label: held.label,
      read: () => {
        this.readLocations.push(held.label.location);
        return held.unreadable
          ? Result.err(this.failure(PresetUnreadable, held.label.location))
          : Result.ok(held.json);
      },
    };
  }

  private failure<Failure>(
    Kind: new (fields: { location: string; detail: string }) => Failure,
    location: string,
  ) {
    return new Kind({ location, detail: faker.lorem.sentence() });
  }
}

interface HeldPreset {
  name: string;
  label: PresetLabel;
  json?: unknown;
  unreadable?: boolean;
}

function aLabel(place: string, name: string): PresetLabel {
  return aPresetLabel({ location: path.join(place, `${name}.${faker.system.fileExt()}`) });
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
