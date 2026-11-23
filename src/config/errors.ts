import { TaggedError } from 'better-result';

/** The configuration, environment, a preset or a step's model choice does not validate. */
export class ConfigInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
