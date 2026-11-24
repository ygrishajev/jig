import { Result } from 'better-result';
import { z } from 'zod';

import { type AgentRole, byRole } from '../domain/agent-role.js';
import { describeIssues } from './describe-issues.js';
import { ConfigInvalid } from './errors.js';
import { type JigConfig, type StepConfig, stepConfigSchema } from './load-config.js';
import type {
  PresetCandidate,
  PresetLabel,
  PresetNotFindable,
  PresetNotJson,
  PresetSource,
  PresetsUnlistable,
  PresetUnreadable,
} from './preset-source.js';

/** The preset a command was asked for: one by name, or one the operator picks from a list. */
export type PresetSelection = { kind: 'named'; name: PresetName } | { kind: 'ask' };

/** What the operator picked from the list: a preset, or the config file alone. */
export type PresetPick = { kind: 'preset'; name: PresetName } | { kind: 'none' };

export interface Preset {
  name: PresetName;
  label: PresetLabel;
  description?: string;
  steps: PresetSteps;
}

type PresetSteps = Partial<Record<AgentRole, StepConfig>>;

interface NamedCandidate {
  name: PresetName;
  candidate: PresetCandidate;
}

type PresetSourceFailure = PresetNotFindable | PresetsUnlistable | PresetUnreadable | PresetNotJson;

export function discoverPresets(source: PresetSource): Result<Preset[], ConfigInvalid> {
  return winningCandidates(source).andThen((winners) => Result.all(winners.map(readPreset)));
}

/** Each name's first candidate, so a preset found earlier shadows the rest and they are never read. */
function winningCandidates(source: PresetSource): Result<NamedCandidate[], ConfigInvalid> {
  return source
    .candidates()
    .mapError(sourceFailure)
    .map((candidates) => shadowedRemoved(candidates.flatMap(validlyNamed)));
}

function sourceFailure(failure: PresetSourceFailure): ConfigInvalid {
  return new ConfigInvalid({ message: sourceFailureMessage(failure) });
}

function sourceFailureMessage(failure: PresetSourceFailure): string {
  switch (failure._tag) {
    case 'PresetNotFindable':
      return `Cannot look for ${failure.location}: ${failure.detail}`;
    case 'PresetsUnlistable':
      return `Cannot list presets in ${failure.location}: ${failure.detail}`;
    case 'PresetUnreadable':
      return `Cannot read ${failure.location}: ${failure.detail}`;
    case 'PresetNotJson':
      return `${failure.location} is not valid JSON: ${failure.detail}`;
  }
}

function shadowedRemoved(candidates: NamedCandidate[]): NamedCandidate[] {
  return candidates.filter(
    (candidate, index) => candidates.findIndex(({ name }) => name === candidate.name) === index,
  );
}

/** A candidate named so that no one could ask for it is not a preset, and is never read. */
function validlyNamed(candidate: PresetCandidate): NamedCandidate[] {
  const name = presetNameSchema.safeParse(candidate.name);
  return name.success ? [{ name: name.data, candidate }] : [];
}

/** A preset name holds no separator or dot, so no source can be led outside the place it looks in. */
export const presetNameSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'a preset name is lowercase letters and digits, joined by single hyphens',
  )
  .brand<'PresetName'>();

export type PresetName = z.infer<typeof presetNameSchema>;

function readPreset({ name, candidate }: NamedCandidate): Result<Preset, ConfigInvalid> {
  return candidate
    .read()
    .mapError(sourceFailure)
    .andThen((json) => parsePreset(name, candidate.label, json));
}

function parsePreset(
  name: PresetName,
  label: PresetLabel,
  json: unknown,
): Result<Preset, ConfigInvalid> {
  const parsed = presetSchema.safeParse(json);
  if (!parsed.success) {
    return Result.err(
      new ConfigInvalid({
        message: `${label.location} is not valid — ${describeIssues(parsed.error)}`,
      }),
    );
  }
  const { description, ...steps } = parsed.data;
  return Result.ok({ name, label, description, steps });
}

/** Strict, so a misspelled step fails at load instead of silently leaving the project's agent. */
const presetSchema = z
  .object({
    description: z.string().optional(),
    ...byRole(() => stepConfigSchema.strict().optional()),
  })
  .strict();

export function configWithPreset(
  config: JigConfig,
  source: PresetSource,
  name: PresetName | undefined,
): Result<JigConfig, ConfigInvalid> {
  if (name === undefined) return Result.ok(config);
  return loadPreset(source, name).map((preset) => applyPreset(config, preset));
}

/**
 * Takes the first candidate for `name` and looks no further, so a broken unrelated preset does not
 * get in the way and a broken winner never yields to a lower-precedence preset.
 */
export function loadPreset(source: PresetSource, name: PresetName): Result<Preset, ConfigInvalid> {
  const [winner] = source.candidatesNamed(name);
  if (winner === undefined) return missingPreset(source, name);
  return winner.mapError(sourceFailure).andThen((candidate) => readPreset({ name, candidate }));
}

function missingPreset(source: PresetSource, name: PresetName): Result<never, ConfigInvalid> {
  return winningCandidates(source).andThen((available) => {
    const searched = source.places.join(', ');
    const offered =
      available.length > 0
        ? `available: ${available.map((winner) => winner.name).join(', ')}`
        : 'there are none';
    return Result.err(
      new ConfigInvalid({
        message: `No preset named ${name} — looked in ${searched}; ${offered}.`,
      }),
    );
  });
}

/** The preset's steps replace the project's whole, so no model carries over to another provider. */
function applyPreset(config: JigConfig, preset: Preset): JigConfig {
  return { ...config, ...preset.steps };
}
