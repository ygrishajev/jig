import { Result } from 'better-result';
import path from 'node:path';
import { z } from 'zod';

import { type AgentRole, byRole } from '../domain/agent-role.js';
import { ConfigInvalid } from '../domain/errors.js';
import { describeIssues } from './describe-issues.js';
import type { JigEnvironment } from './environment.js';
import { type JigConfig, type StepConfig, stepConfigSchema } from './load-config.js';

export interface PresetLocations extends Pick<JigEnvironment, 'homeDirectory' | 'xdgConfigHome'> {
  repoRoot: string;
}

/** The file system behind preset discovery and named loading: where presets are, and what they hold. */
export interface PresetFiles {
  /** Each source's preset directory, absolute; the starters' is the package's own. */
  directories(roots: PresetRoots): Record<PresetSource, string>;
  /** The preset files in a directory, none when nothing is at its path. */
  filesIn(directory: string): Result<PresetEntry[], ConfigInvalid>;
  /** Where a preset of this name would be in a directory. */
  fileFor(directory: string, name: PresetName): string;
  /** Anything at the path counts, a dangling link included; only an absent entry is not present. */
  isPresent(entryPath: string): Result<boolean, ConfigInvalid>;
  /** The file's JSON, not yet checked against the preset schema. */
  read(filePath: string): Result<unknown, ConfigInvalid>;
}

/** The roots each source's preset directory is found under, as preset policy accepts them. */
export interface PresetRoots {
  repoRoot: string;
  homeDirectory: string;
  /** Only an absolute XDG config home; without one, the XDG default under the home directory. */
  xdgConfigHome?: string;
}

/** A preset file in a directory, under the name its file gives it, which may be no valid preset name. */
export interface PresetEntry {
  name: string;
  path: string;
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

export function discoverPresets(
  files: PresetFiles,
  locations: PresetLocations,
): Result<Preset[], ConfigInvalid> {
  return winningPresetFiles(files, presetDirectories(files, locations)).andThen((found) =>
    Result.all(found.map((file) => readPreset(files, file))),
  );
}

function winningPresetFiles(
  files: PresetFiles,
  directories: PresetDirectory[],
): Result<PresetFile[], ConfigInvalid> {
  return Result.all(directories.map((directory) => presetFilesIn(files, directory))).map(
    (perDirectory) => shadowedRemoved(perDirectory.flat()),
  );
}

function presetFilesIn(
  files: PresetFiles,
  directory: PresetDirectory,
): Result<PresetFile[], ConfigInvalid> {
  return files
    .filesIn(directory.path)
    .map((entries) =>
      entries
        .flatMap((entry) => presetFileFrom(entry, directory.source))
        .sort((first, second) => (first.name < second.name ? -1 : 1)),
    );
}

/** A file named so that no one could ask for it is not a preset, and is never read. */
function presetFileFrom(entry: PresetEntry, source: PresetSource): PresetFile[] {
  const name = presetNameSchema.safeParse(entry.name);
  return name.success ? [{ name: name.data, source, path: entry.path }] : [];
}

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

function shadowedRemoved(files: PresetFile[]): PresetFile[] {
  return files.filter((file, index) => files.findIndex(({ name }) => name === file.name) === index);
}

/** Each source's directory in precedence order, a directory two sources share named once, by the first. */
export function presetDirectories(
  files: PresetFiles,
  locations: PresetLocations,
): PresetDirectory[] {
  const paths = files.directories(presetRoots(locations));
  const directories = PRESET_SOURCES.map((source) => ({ source, path: paths[source] }));
  return directories.filter(
    (directory, index) => directories.findIndex(({ path }) => path === directory.path) === index,
  );
}

/** The XDG config home is ignored unless absolute, as the XDG base directory spec requires. */
function presetRoots({ repoRoot, homeDirectory, xdgConfigHome }: PresetLocations): PresetRoots {
  const acceptedXdgConfigHome =
    xdgConfigHome && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : undefined;
  return { repoRoot, homeDirectory, xdgConfigHome: acceptedXdgConfigHome };
}

/** Where presets are looked for, highest precedence first: a name found earlier shadows the rest. */
export const PRESET_SOURCES = ['repository', 'home', 'xdg', 'builtin'] as const;
export type PresetSource = (typeof PRESET_SOURCES)[number];

function readPreset(files: PresetFiles, file: PresetFile): Result<Preset, ConfigInvalid> {
  return files.read(file.path).andThen((json) => parsePresetFile(file, json));
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

export function configWithPreset(
  config: JigConfig,
  files: PresetFiles,
  locations: PresetLocations,
  name: PresetName | undefined,
): Result<JigConfig, ConfigInvalid> {
  if (name === undefined) return Result.ok(config);
  return loadPreset(files, locations, name).map((preset) => applyPreset(config, preset));
}

/**
 * Reads only the file that holds `name`, so a broken unrelated preset does not get in the way. The
 * first present candidate wins even when it cannot be read, so a broken winner never yields to a
 * lower-precedence preset.
 */
export function loadPreset(
  files: PresetFiles,
  locations: PresetLocations,
  name: PresetName,
): Result<Preset, ConfigInvalid> {
  const directories = presetDirectories(files, locations);
  return Result.gen(function* () {
    for (const directory of directories) {
      const candidate = {
        name,
        source: directory.source,
        path: files.fileFor(directory.path, name),
      };
      if (yield* files.isPresent(candidate.path)) return readPreset(files, candidate);
    }
    return missingPreset(files, name, directories);
  });
}

function missingPreset(
  files: PresetFiles,
  name: PresetName,
  directories: PresetDirectory[],
): Result<never, ConfigInvalid> {
  return winningPresetFiles(files, directories).andThen((available) => {
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
function applyPreset(config: JigConfig, preset: Preset): JigConfig {
  return { ...config, ...preset.steps };
}
