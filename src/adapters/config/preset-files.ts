import { Result } from 'better-result';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PresetEntry, PresetFiles, PresetRoots, PresetSource } from '../../config/presets.js';
import { JIG_DIR } from '../../config/scratch-directory.js';
import { ConfigInvalid, messageOf } from '../../domain/errors.js';

/** Presets on disk; the starters are read from `builtinDirectory`, the package's own unless a spec points elsewhere. */
export function presetFilesOnDisk(builtinDirectory = packagedPresetsDirectory()): PresetFiles {
  return {
    directories: (roots) => presetDirectoriesUnder(roots, builtinDirectory),
    filesIn: presetEntriesIn,
    fileFor: (directory, name) => path.join(directory, `${name}${PRESET_EXTENSION}`),
    isPresent,
    read: readJson,
  };
}

/** The starters ship in the package's `presets/`, three levels up from both `src/adapters/config/` and `dist/adapters/config/`. */
export function packagedPresetsDirectory(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('../../../presets', moduleUrl));
}

function presetDirectoriesUnder(
  { repoRoot, homeDirectory, xdgConfigHome = path.join(homeDirectory, '.config') }: PresetRoots,
  builtinDirectory: string,
): Record<PresetSource, string> {
  return {
    repository: path.resolve(repoRoot, JIG_DIR, 'presets'),
    home: path.resolve(homeDirectory, JIG_DIR, 'presets'),
    xdg: path.resolve(xdgConfigHome, 'jig', 'presets'),
    builtin: path.resolve(builtinDirectory),
  };
}

function presetEntriesIn(directory: string): Result<PresetEntry[], ConfigInvalid> {
  return Result.gen(function* () {
    if (!(yield* isPresent(directory))) return Result.ok([]);
    const entries = yield* Result.try({
      try: () => readdirSync(directory),
      catch: (cause) =>
        new ConfigInvalid({ message: `Cannot list presets in ${directory}: ${messageOf(cause)}` }),
    });
    return Result.ok(
      entries
        .filter((entry) => entry.endsWith(PRESET_EXTENSION))
        .map((entry) => ({
          name: entry.slice(0, -PRESET_EXTENSION.length),
          path: path.join(directory, entry),
        })),
    );
  });
}

/** lstat, so a dangling link is present, and only ENOENT counts as absent. */
function isPresent(entryPath: string): Result<boolean, ConfigInvalid> {
  return Result.try({ try: () => lstatSync(entryPath), catch: (cause) => cause }).match({
    ok: () => Result.ok(true),
    err: (cause) =>
      cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
        ? Result.ok(false)
        : Result.err(
            new ConfigInvalid({ message: `Cannot look for ${entryPath}: ${messageOf(cause)}` }),
          ),
  });
}

const PRESET_EXTENSION = '.json';

function readJson(filePath: string): Result<unknown, ConfigInvalid> {
  return Result.try({
    try: () => readFileSync(filePath, 'utf-8'),
    catch: (cause) =>
      new ConfigInvalid({ message: `Cannot read ${filePath}: ${messageOf(cause)}` }),
  }).andThen((contents) =>
    Result.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) =>
        new ConfigInvalid({ message: `${filePath} is not valid JSON: ${messageOf(cause)}` }),
    }),
  );
}
