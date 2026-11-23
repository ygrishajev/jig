import { Result } from 'better-result';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { JigEnvironment } from '../../config/environment.js';
import {
  type PresetCandidate,
  PresetNotFindable,
  PresetNotJson,
  type PresetSource,
  PresetsUnlistable,
  PresetUnreadable,
} from '../../config/preset-source.js';
import type { PresetName } from '../../config/presets.js';
import { JIG_DIR } from '../../config/scratch-directory.js';
import { messageOf } from '../../failures/messages.js';

/** What the preset directories are found under: the repository, the operator's home and their XDG config home. */
export interface PresetLocations extends Pick<JigEnvironment, 'homeDirectory' | 'xdgConfigHome'> {
  repoRoot: string;
}

interface PresetDirectory {
  source: PresetDirectoryName;
  path: string;
}

export function presetDirectoriesSource(
  locations: PresetLocations,
  starterDirectory = packagedPresetsDirectory(),
): PresetSource {
  const directories = presetDirectories(locations, starterDirectory);
  return {
    places: directories.map((directory) => directory.path),
    candidatesNamed: (name) => candidatesNamed(directories, name),
    candidates: () =>
      Result.all(directories.map(candidatesIn)).map((perDirectory) => perDirectory.flat()),
  };
}

/** The starters ship in the package's `presets/`, three levels up from both `src/adapters/filesystem/` and `dist/adapters/filesystem/`. */
export function packagedPresetsDirectory(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('../../../presets', moduleUrl));
}

/** A directory two sources share is looked in once, for the source that takes precedence. */
function presetDirectories(
  locations: PresetLocations,
  starterDirectory: string,
): PresetDirectory[] {
  const paths = directoryPaths(locations, starterDirectory);
  const directories = PRESET_DIRECTORIES.map((source) => ({ source, path: paths[source] }));
  return directories.filter(
    (directory, index) => directories.findIndex(({ path }) => path === directory.path) === index,
  );
}

function directoryPaths(
  { repoRoot, homeDirectory, xdgConfigHome }: PresetLocations,
  starterDirectory: string,
): Record<PresetDirectoryName, string> {
  return {
    repository: path.resolve(repoRoot, JIG_DIR, 'presets'),
    home: path.resolve(homeDirectory, JIG_DIR, 'presets'),
    xdg: path.resolve(configHome(homeDirectory, xdgConfigHome), 'jig', 'presets'),
    builtin: path.resolve(starterDirectory),
  };
}

/** The XDG config home counts only when absolute, as the XDG base directory spec requires; `~/.config` otherwise. */
function configHome(homeDirectory: string, xdgConfigHome: string | undefined): string {
  return xdgConfigHome && path.isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : path.join(homeDirectory, '.config');
}

/** Where presets are looked for, highest precedence first. */
const PRESET_DIRECTORIES = ['repository', 'home', 'xdg', 'builtin'] as const;

type PresetDirectoryName = (typeof PRESET_DIRECTORIES)[number];

function* candidatesNamed(
  directories: PresetDirectory[],
  name: PresetName,
): Generator<Result<PresetCandidate, PresetNotFindable>> {
  for (const directory of directories) {
    const candidate = candidateAt(directory, name);
    const present = isPresent(candidate.label.location);
    if (present.isErr()) {
      yield Result.err(present.error);
      return;
    }
    if (present.value) yield Result.ok(candidate);
  }
}

function candidateAt(directory: PresetDirectory, name: string): PresetCandidate {
  const filePath = path.join(directory.path, `${name}${PRESET_EXTENSION}`);
  return {
    name,
    label: {
      source: directory.source,
      location: filePath,
      starter: directory.source === 'builtin',
    },
    read: () => readJson(filePath),
  };
}

const PRESET_EXTENSION = '.json';

function readJson(filePath: string): Result<unknown, PresetUnreadable | PresetNotJson> {
  return Result.try({
    try: () => readFileSync(filePath, 'utf-8'),
    catch: (cause) => new PresetUnreadable({ location: filePath, detail: messageOf(cause) }),
  }).andThen((contents) =>
    Result.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) => new PresetNotJson({ location: filePath, detail: messageOf(cause) }),
    }),
  );
}

/** lstat, so a dangling link is present, and only a missing entry counts as absent. */
function isPresent(entryPath: string): Result<boolean, PresetNotFindable> {
  return Result.try({
    try: () => lstatSync(entryPath, { throwIfNoEntry: false }),
    catch: (cause) => new PresetNotFindable({ location: entryPath, detail: messageOf(cause) }),
  }).map((entry) => entry !== undefined);
}

function candidatesIn(
  directory: PresetDirectory,
): Result<PresetCandidate[], PresetNotFindable | PresetsUnlistable> {
  return Result.gen(function* () {
    if (!(yield* isPresent(directory.path))) return Result.ok([]);
    const entries = yield* Result.try({
      try: () => readdirSync(directory.path),
      catch: (cause) =>
        new PresetsUnlistable({ location: directory.path, detail: messageOf(cause) }),
    });
    return Result.ok(
      entries
        .filter((entry) => entry.endsWith(PRESET_EXTENSION))
        .map((entry) => entry.slice(0, -PRESET_EXTENSION.length))
        .sort()
        .map((name) => candidateAt(directory, name)),
    );
  });
}
