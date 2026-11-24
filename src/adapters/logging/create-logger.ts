import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { type DestinationStream, type Logger, type LoggerOptions, pino } from 'pino';
import pretty from 'pino-pretty';

import type { LogFormat } from '../../ports/observability.js';
import { serializeError } from './error-serializer.js';

/** Pretty for a person at a terminal, JSON lines everywhere else (CI, pipes, files). */
export function defaultLogFormat(stream: { isTTY?: boolean } = process.stdout): LogFormat {
  return stream.isTTY ? 'pretty' : 'json';
}

export function createConsoleLogger(
  format: LogFormat,
  level = 'info',
  consoleDestination: DestinationStream = consoleStream(format),
): Logger {
  return pino(loggerOptions(level), consoleDestination);
}

function consoleStream(format: LogFormat): DestinationStream {
  if (format === 'json') return pino.destination({ dest: 1, sync: true });
  return pretty({ sync: true, ignore: 'pid,hostname,event,runId,at', translateTime: 'HH:MM:ss' });
}

function loggerOptions(level: string): LoggerOptions {
  return { level, serializers: { err: serializeError } };
}

/**
 * The console logger plus a JSON log file for the run, so a run can be inspected afterwards
 * whatever the console showed.
 */
export function createRunLogger(
  format: LogFormat,
  logFile: string,
  level = 'info',
  consoleDestination: DestinationStream = consoleStream(format),
): Logger {
  mkdirSync(path.dirname(logFile), { recursive: true });
  return pino(
    loggerOptions(level),
    pino.multistream([
      { level, stream: consoleDestination },
      { level, stream: pino.destination({ dest: logFile, sync: true }) },
    ]),
  );
}
