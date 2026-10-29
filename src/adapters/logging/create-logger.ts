import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pino, type DestinationStream, type Logger } from 'pino';
import pretty from 'pino-pretty';

export type LogFormat = 'pretty' | 'json';

/** Pretty for a person at a terminal, JSON lines everywhere else (CI, pipes, files). */
export function defaultLogFormat(stream: { isTTY?: boolean } = process.stdout): LogFormat {
  return stream.isTTY ? 'pretty' : 'json';
}

export function createConsoleLogger(format: LogFormat, level = 'info'): Logger {
  return pino({ level }, consoleStream(format));
}

/**
 * The console logger plus a JSON log file for the run, so a run can be inspected afterwards
 * whatever the console showed.
 */
export function createRunLogger(format: LogFormat, logFile: string, level = 'info'): Logger {
  mkdirSync(path.dirname(logFile), { recursive: true });
  return pino(
    { level },
    pino.multistream([
      { level, stream: consoleStream(format) },
      { level, stream: pino.destination({ dest: logFile, sync: true }) },
    ]),
  );
}

function consoleStream(format: LogFormat): DestinationStream {
  if (format === 'json') return pino.destination({ dest: 1, sync: true });
  return pretty({ sync: true, ignore: 'pid,hostname,event,runId,at', translateTime: 'HH:MM:ss' });
}
