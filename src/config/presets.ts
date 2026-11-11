import { Result } from 'better-result';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { JIG_DIR } from '../adapters/local-store/run-paths.js';
import { type AgentRole, byRole } from '../domain/agent-role.js';
import { ConfigInvalid, messageOf } from '../domain/errors.js';
import { describeIssues } from './describe-issues.js';
import { type JigConfig, type StepConfig, stepConfigSchema } from './load-config.js';

/** What decides where presets live; the caller reads these from the process, nothing here does. */
export interface PresetLocations {
  repoRoot: string;
  homeDirectory: string;
  /** Ignored unless absolute, as the XDG base directory spec requires. */
  xdgConfigHome?: string;
}

export interface Preset {
  name: PresetName;
  source: PresetSource;
  path: string;
  description?: string;
  steps: PresetSteps;
}

export type PresetSteps = Partial<Record<AgentRole, StepConfig>>;

export interface PresetDirectory {
  source: PresetSource;
  path: string;
}

interface PresetFile {
  name: PresetName;
  source: PresetSource;
  path: string;
}

/** Every preset an operator can name, each from the directory that wins it. */
export function discoverPresets(locations: PresetLocations): Result<Preset[], ConfigInvalid> {
  return presetFiles(presetDirectories(locations)).andThen((files) =>
    Result.all(files.map(readPreset)),
  );
}

function presetFiles(directories: PresetDirectory[]): Result<PresetFile[], ConfigInvalid> {
  return Result.all(directories.map(presetFilesIn)).map((perDirectory) =>
    shadowedRemoved(perDirectory.flat()),
  );
}

function presetFilesIn(directory: PresetDirectory): Result<PresetFile[], ConfigInvalid> {
  if (!existsSync(directory.path)) return Result.ok([]);
  return Result.try({
    try: () => readdirSync(directory.path),
    catch: (cause) =>
      new ConfigInvalid({
        message: `Cannot list presets in ${directory.path}: ${messageOf(cause)}`,
      }),
  }).map((entries) => presetNamesAmong(entries).map((name) => presetFileIn(directory, name)));
}

function presetNamesAmong(entries: string[]): PresetName[] {
  return entries
    .filter((entry) => entry.endsWith(PRESET_EXTENSION))
    .map((entry) => presetNameSchema.safeParse(entry.slice(0, -PRESET_EXTENSION.length)))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .sort();
}

const PRESET_EXTENSION = '.json';

/** A preset name becomes a file name, so nothing that could leave the presets directory gets through. */
export const presetNameSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'a preset name is lowercase letters and digits, joined by single hyphens',
  )
  .brand<'PresetName'>();

export type PresetName = z.infer<typeof presetNameSchema>;

function presetFileIn(directory: PresetDirectory, name: PresetName): PresetFile {
  return { name, source: directory.source, path: path.join(directory.path, fileNameOf(name)) };
}

function fileNameOf(name: PresetName): string {
  return `${name}${PRESET_EXTENSION}`;
}

function shadowedRemoved(files: PresetFile[]): PresetFile[] {
  return files.filter((file, index) => files.findIndex(({ name }) => name === file.name) === index);
}

/** The directories presets are read from, in precedence order, each named once. */
export function presetDirectories(locations: PresetLocations): PresetDirectory[] {
  const paths = directoryPaths(locations);
  const directories = PRESET_SOURCES.map((source) => ({
    source,
    path: path.resolve(paths[source]),
  }));
  return directories.filter(
    (directory, index) => directories.findIndex(({ path }) => path === directory.path) === index,
  );
}

function directoryPaths({
  repoRoot,
  homeDirectory,
  xdgConfigHome,
}: PresetLocations): Record<PresetSource, string> {
  const xdgRoot =
    xdgConfigHome && path.isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : path.join(homeDirectory, '.config');
  return {
    repository: path.join(repoRoot, JIG_DIR, 'presets'),
    home: path.join(homeDirectory, JIG_DIR, 'presets'),
    xdg: path.join(xdgRoot, 'jig', 'presets'),
  };
}

/** Where presets are looked for, highest precedence first: a name found earlier shadows the rest. */
export const PRESET_SOURCES = ['repository', 'home', 'xdg'] as const;
export type PresetSource = (typeof PRESET_SOURCES)[number];

function readPreset(file: PresetFile): Result<Preset, ConfigInvalid> {
  return Result.try({
    try: () => readFileSync(file.path, 'utf-8'),
    catch: (cause) =>
      new ConfigInvalid({ message: `Cannot read ${file.path}: ${messageOf(cause)}` }),
  })
    .andThen((contents) =>
      Result.try({
        try: (): unknown => JSON.parse(contents),
        catch: (cause) =>
          new ConfigInvalid({ message: `${file.path} is not valid JSON: ${messageOf(cause)}` }),
      }),
    )
    .andThen((json) => parsePresetFile(file, json));
}

function parsePresetFile(file: PresetFile, json: unknown): Result<Preset, ConfigInvalid> {
  const parsed = presetFileSchema.safeParse(json);
  if (!parsed.success) {
    return Result.err(
      new ConfigInvalid({
        message: `${file.path} is not valid — ${describeIssues(parsed.error)}`,
      }),
    );
  }
  const { description, ...steps } = parsed.data;
  return Result.ok({ ...file, description, steps });
}

/** Strict, so a misspelled step fails at load instead of silently leaving the project's agent. */
const presetFileSchema = z
  .object({
    description: z.string().optional(),
    ...byRole(() => stepConfigSchema.strict().optional()),
  })
  .strict();

/** Reads only the files that could hold `name`, so a broken unrelated preset does not get in the way. */
export function loadPreset(
  locations: PresetLocations,
  name: PresetName,
): Result<Preset, ConfigInvalid> {
  const directories = presetDirectories(locations);
  const winner = directories
    .map((directory) => presetFileIn(directory, name))
    .find((file) => existsSync(file.path));
  return winner ? readPreset(winner) : missingPreset(name, directories);
}

function missingPreset(
  name: PresetName,
  directories: PresetDirectory[],
): Result<never, ConfigInvalid> {
  return presetFiles(directories).andThen((available) => {
    const searched = directories.map((directory) => directory.path).join(', ');
    const offered =
      available.length > 0
        ? `available: ${available.map((file) => file.name).join(', ')}`
        : 'there are none';
    return Result.err(
      new ConfigInvalid({
        message: `No preset named ${name} — looked in ${searched}; ${offered}.`,
      }),
    );
  });
}

/** The preset's steps replace the project's whole, so no model carries over to another provider. */
export function applyPreset(config: JigConfig, preset: Preset): JigConfig {
  return { ...config, ...preset.steps };
}
