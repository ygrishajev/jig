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

/**
 * A file jig reads or writes to prepare a run or `jig init` is unusable: the credentials file
 * cannot be read, parsed or safely saved, a path is a symbolic link, or a repository file cannot be written.
 */
export class LocalPreparationFailed extends TaggedError('LocalPreparationFailed')<{
  message: string;
}> {
  readonly kind = 'fatal' as const;
}
