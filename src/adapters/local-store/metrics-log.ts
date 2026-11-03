import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { agentRoleSchema } from '../../domain/agent-role.js';
import { MetricsLogCorrupt } from '../../domain/errors.js';
import { stepLocationSchema } from '../../domain/events.js';
import { outcomeTypeSchema } from '../../domain/outcome.js';
import { type RunId, runIdSchema } from '../../domain/run-id.js';
import {
  type MetricRecord,
  type MetricsSummary,
  summarizeMetrics,
} from '../../observers/metrics.js';
import { stateDirectory } from './run-paths.js';

/**
 * Appends metric records to `.jig/<runId>/state/metrics.jsonl`, one JSON object per line,
 * across every invocation of the run. Appends are synchronous so records keep event order.
 * A record counts once its line is complete: a process killed mid-append can only leave the
 * last line without its newline, so that tail is ignored on read and cut off before the next
 * append. A complete line that is not a record cannot come from a crash, so it fails loudly.
 */
export class MetricsLog {
  private readonly file: string;

  private tornTailRemoved = false;

  constructor(repoRoot: string, runId: RunId) {
    this.file = path.join(stateDirectory(repoRoot, runId), 'metrics.jsonl');
  }

  append(record: MetricRecord): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (!this.tornTailRemoved) {
      this.removeTornTail();
      this.tornTailRemoved = true;
    }
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  private removeTornTail(): void {
    if (!existsSync(this.file)) return;
    const contents = readFileSync(this.file);
    const completeLength = contents.lastIndexOf('\n') + 1;
    if (completeLength < contents.length) truncateSync(this.file, completeLength);
  }

  /** The run's totals so far, across every invocation this machine ran. */
  summary(): MetricsSummary {
    return summarizeMetrics(this.readAll());
  }

  readAll(): MetricRecord[] {
    if (!existsSync(this.file)) return [];
    return completeLines(readFileSync(this.file, 'utf-8')).map((line, index) =>
      this.parseLine(line, index + 1),
    );
  }

  private parseLine(line: string, lineNumber: number): MetricRecord {
    const parsed = metricRecordSchema.safeParse(parseJson(line));
    if (!parsed.success) {
      throw new MetricsLogCorrupt(
        `Line ${lineNumber} of ${this.file} is not a metric record: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }
}

function completeLines(contents: string): string[] {
  return contents
    .slice(0, contents.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean);
}

const metricRecordSchema: z.ZodType<MetricRecord, z.ZodTypeDef, unknown> = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('step'),
      at: z.string(),
      runId: runIdSchema,
      location: stepLocationSchema,
      outcome: outcomeTypeSchema,
      durationMs: z.number(),
      commit: z
        .object({
          sha: z.string(),
          filesChanged: z.number(),
          insertions: z.number(),
          deletions: z.number(),
        })
        .optional(),
    }),
    z.object({
      kind: z.literal('agentCall'),
      at: z.string(),
      runId: runIdSchema,
      location: stepLocationSchema.optional(),
      role: agentRoleSchema,
      costUsd: z.number().optional(),
      tokens: z.object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
        reasoning: z.number(),
      }),
    }),
    z.object({
      kind: z.literal('retry'),
      at: z.string(),
      runId: runIdSchema,
      location: stepLocationSchema,
      reason: z.string(),
    }),
  ],
);

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
