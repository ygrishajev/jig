import { TaggedError } from 'better-result';

/**
 * Reading or writing jig's own files on this machine failed, under `.jig/` or in a temporary
 * directory: a full disk, a permission, a file that is not there.
 */
export class LocalStateUnwritable extends TaggedError('LocalStateUnwritable')<{
  message: string;
  path: string;
}> {
  readonly kind = 'fatal' as const;
}

/** Keeps the legacy `ConfigInvalid` serialized/log tag and fatal classification; never dispatch on the tag. */
export class FilesystemPreparationFailed extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
