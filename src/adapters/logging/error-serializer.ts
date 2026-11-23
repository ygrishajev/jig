import { pino } from 'pino';

/**
 * pino's own `err` serializer, with a split class logged under its legacy identity. It works on
 * the serialized copy, so the failure itself keeps its tag; message and stack frames are kept.
 */
export function serializeError(value: unknown): unknown {
  if (!isErrorLike(value)) return value;
  const serialized = pino.stdSerializers.err(value);
  const tag: unknown = serialized._tag;
  if (typeof tag !== 'string' || !SPLIT_FROM_CONFIG_INVALID.has(tag) || serialized.type !== tag) {
    return serialized;
  }
  return {
    ...serialized,
    type: LEGACY_IDENTITY,
    _tag: LEGACY_IDENTITY,
    name: LEGACY_IDENTITY,
    stack: serialized.stack.startsWith(`${tag}:`)
      ? `${LEGACY_IDENTITY}${serialized.stack.slice(tag.length)}`
      : serialized.stack,
  };
}

/** pino's own test for a value its `err` serializer serializes; it logs anything else as it is. */
function isErrorLike(value: unknown): value is Error {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
  );
}

/**
 * Classes split out of `ConfigInvalid`. Logs written before the split name them `ConfigInvalid`,
 * so a logged `err` keeps that identity and a reader of old and new logs matches one name.
 */
const SPLIT_FROM_CONFIG_INVALID = new Set([
  'RunStateInvalid',
  'RunStoreOperationFailed',
  'RunStoreSetupInvalid',
  'SandboxCredentialsInvalid',
  'SandboxPreparationInvalid',
  'RepositoryInvalid',
  'LocalPreparationFailed',
]);

const LEGACY_IDENTITY = 'ConfigInvalid';
