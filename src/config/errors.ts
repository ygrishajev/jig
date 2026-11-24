import { TaggedError } from 'better-result';

/** The configuration, environment, a preset or a step's model choice does not validate. */
export class ConfigInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

/**
 * The GitHub settings do not validate: no token, or a repository name that is not GitHub's
 * `owner/repository`. The GitHub command reports it as the GitHub port's `GithubSetupInvalid`.
 */
export class GithubSettingsInvalid extends TaggedError('GithubSettingsInvalid')<{
  message: string;
}> {}
