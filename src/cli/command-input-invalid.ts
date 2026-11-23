import { TaggedError } from 'better-result';

export class CommandInputInvalid extends TaggedError('CommandInputInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
