import { type Result, TaggedError } from 'better-result';

/**
 * Where a command's settings are kept. It moves them as JSON and says what it found; config
 * decides what an absent destination means and what the JSON must hold.
 */
export interface ConfigSource {
  /** The destination as the operator knows it. */
  readonly name: string;
  /** The operator chose this destination with `--config`, instead of the repository's own. */
  readonly custom: boolean;
  read(): Result<ConfigContents, ConfigUnreadable | ConfigNotJson>;
  /** Replaces everything at the destination, creating it if nothing is there yet. */
  write(settings: Record<string, unknown>): Promise<Result<void, ConfigUnwritable>>;
}

/** `detail` says why nothing could be found, for a caller that needed something there. */
export type ConfigContents =
  { kind: 'absent'; detail: string } | { kind: 'present'; json: unknown };

export class ConfigUnreadable extends TaggedError('ConfigUnreadable')<{
  location: string;
  detail: string;
}> {}

export class ConfigNotJson extends TaggedError('ConfigNotJson')<{ detail: string }> {}

export class ConfigUnwritable extends TaggedError('ConfigUnwritable')<{
  location: string;
  detail: string;
}> {}
