import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { MetricRecord } from '../../observers/metrics.js';
import { stateDirectory } from './run-paths.js';

/**
 * Appends metric records to `.sdlc/<runId>/state/metrics.jsonl`, one JSON object per line,
 * across every invocation of the run. Appends are synchronous so records keep event order.
 */
export class MetricsLog {
  private readonly file: string;

  constructor(repoRoot: string, runId: string) {
    this.file = path.join(stateDirectory(repoRoot, runId), 'metrics.jsonl');
  }

  append(record: MetricRecord) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  readAll(): MetricRecord[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MetricRecord);
  }
}
