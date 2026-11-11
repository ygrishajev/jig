import { Result } from 'better-result';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { JIG_DIR } from '../adapters/local-store/run-paths.js';
import { type AgentRole, byRole } from '../domain/agent-role.js';
import { ConfigInvalid, messageOf } from '../domain/errors.js';
import { describeIssues } from './describe-issues.js';
import { type JigConfig, type StepConfig, stepConfigSchema } from './load-config.js';

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
  return Result.gen(function* () {
    if (!(yield* existsAt(directory.path))) return Result.ok([]);
    const entries = yield* Result.try({
      try: () => readdirSync(directory.path),
      catch: (cause) =>
        new ConfigInvalid({
          message: `Cannot list presets in ${directory.path}: ${messageOf(cause)}`,
        }),
    });
    return Result.ok(presetNamesAmong(entries).map((name) => presetFileIn(directory, name)));
  });
}

/** Only a missing entry is absent; any other failure is reported, so an unreadable winner never yields to a lower-precedence preset. */
function existsAt(entryPath: string): Result<boolean, ConfigInvalid> {
  return Result.try({
    try: () => statSync(entryPath, { throwIfNoEntry: false }),
    catch: (cause) =>
      new ConfigInvalid({ message: `Cannot look for ${entryPath}: ${messageOf(cause)}` }),
  }).map((stats) => stats !== undefined);
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
  return Result.gen(function* () {
    const contents = yield* Result.try({
      try: () => readFileSync(file.path, 'utf-8'),
      catch: (cause) =>
        new ConfigInvalid({ message: `Cannot read ${file.path}: ${messageOf(cause)}` }),
    });
    const json = yield* Result.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) =>
        new ConfigInvalid({ message: `${file.path} is not valid JSON: ${messageOf(cause)}` }),
    });
    return parsePresetFile(file, json);
  });
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
  return Result.gen(function* () {
    for (const directory of directories) {
      const candidate = presetFileIn(directory, name);
      if (yield* existsAt(candidate.path)) return readPreset(candidate);
    }
    return missingPreset(name, directories);
  });
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
