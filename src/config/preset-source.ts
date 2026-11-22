import { type Result, TaggedError } from 'better-result';

import type { PresetName } from './presets.js';

/**
 * Where presets are kept, in precedence order. It looks at a place only when asked and decodes a
 * candidate only when read; config decides which names count, which candidate wins and what a
 * preset must hold.
 */
export interface PresetSource {
  /** Every place presets are looked for, highest precedence first, as the operator knows it. */
  readonly places: readonly string[];
  /** The present candidates for `name`, highest precedence first, each place looked at only when reached. */
  candidatesNamed(name: PresetName): Iterable<Result<PresetCandidate, PresetNotFindable>>;
  /** Every candidate present, highest-precedence place first and each place's in name order. */
  candidates(): Result<PresetCandidate[], PresetNotFindable | PresetsUnlistable>;
}

export interface PresetCandidate {
  /** The name its place gives it, which may be no valid preset name. */
  readonly name: string;
  readonly label: PresetLabel;
  /** The JSON it holds, not yet checked against the preset schema. */
  read(): Result<unknown, PresetUnreadable | PresetNotJson>;
}

/** Where a candidate was found, for the operator; config hands it on without reading it. */
export interface PresetLabel {
  source: string;
  path: string;
  /** One of the starters jig ships, rather than a preset the operator keeps. */
  starter: boolean;
}

export class PresetNotFindable extends TaggedError('PresetNotFindable')<{
  location: string;
  detail: string;
}> {}

export class PresetsUnlistable extends TaggedError('PresetsUnlistable')<{
  location: string;
  detail: string;
}> {}

export class PresetUnreadable extends TaggedError('PresetUnreadable')<{
  location: string;
  detail: string;
}> {}

export class PresetNotJson extends TaggedError('PresetNotJson')<{
  location: string;
  detail: string;
}> {}
