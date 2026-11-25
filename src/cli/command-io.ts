import type { LogFormat } from '../ports/observability.js';
import type { RequestInputs } from '../ports/request-inputs.js';

/** What the commands read and report through, and the defaults that depend on where they run. */
export interface CommandIo {
  requestInputs: RequestInputs;
  outcomeLog(format: LogFormat): OutcomeLog;
  /** The format a command logs in when `--log-format` is not given. */
  defaultLogFormat: LogFormat;
}

export interface OutcomeLog {
  info(details: object, message: string): void;
}
