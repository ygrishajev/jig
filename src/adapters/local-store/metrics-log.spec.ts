import { faker } from '@faker-js/faker';
import { appendFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aCommit, runId, sliceId, tokenUsage } from '../../../tests/support/builders.js';
import type { RunId } from '../../domain/run-id.js';
import { MetricsLogCorrupt } from '../../domain/errors.js';
import type { MetricRecord } from '../../observers/metrics.js';
import { MetricsLog } from './metrics-log.js';
import { stateDirectory } from './run-paths.js';

describe('MetricsLog', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('reads back every record it appended, in order', async () => {
    const { log, id } = await setup();
    const records = [stepRecord(id), agentCallRecord(id), retryRecord(id)];

    for (const record of records) log.append(record);

    expect(log.readAll()).toEqual(records);
  });

  it('leaves out a last line cut short by a process killed mid-append', async () => {
    const { log, id, appendRaw } = await setup();
    const complete = [stepRecord(id), agentCallRecord(id)];
    for (const record of complete) log.append(record);

    appendRaw(tornLine(stepRecord(id)));

    expect(log.readAll()).toEqual(complete);
  });

  it('appends after a torn last line without gluing onto it', async () => {
    const { log, id, appendRaw, reopen } = await setup();
    const first = stepRecord(id);
    log.append(first);
    appendRaw(tornLine(agentCallRecord(id)));
    const next = retryRecord(id);

    reopen().append(next);

    expect(reopen().readAll()).toEqual([first, next]);
  });

  it.each([
    ['is not JSON', () => faker.lorem.word()],
    ['is not a metric record', () => JSON.stringify({ kind: faker.word.noun() })],
  ])('refuses a complete line in the middle that %s', async (_case, corruptLine) => {
    const { log, id, appendRaw } = await setup();
    log.append(stepRecord(id));
    appendRaw(`${corruptLine()}\n`);
    log.append(retryRecord(id));

    expect(() => log.readAll()).toThrow(MetricsLogCorrupt);
  });

  async function setup() {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'sdlc-metrics-'));
    directories.push(repoRoot);
    const id = runId();
    const reopen = () => new MetricsLog(repoRoot, id);
    const appendRaw = (text: string) =>
      appendFileSync(path.join(stateDirectory(repoRoot, id), 'metrics.jsonl'), text);
    return { log: reopen(), id, appendRaw, reopen };
  }
});

function tornLine(record: MetricRecord) {
  const line = JSON.stringify(record);
  return line.slice(0, faker.number.int({ min: 1, max: line.length - 1 }));
}

function stepRecord(id: RunId): MetricRecord {
  return {
    kind: 'step',
    at: faker.date.recent().toISOString(),
    runId: id,
    location: { phase: 'slices', sliceId: sliceId(), sliceStatus: 'pending' },
    outcome: 'implemented',
    durationMs: faker.number.int({ min: 1, max: 600_000 }),
    commit: aCommit(),
  };
}

function agentCallRecord(id: RunId): MetricRecord {
  return {
    kind: 'agentCall',
    at: faker.date.recent().toISOString(),
    runId: id,
    location: { phase: 'planning' },
    role: 'planner',
    costUsd: faker.number.float({ min: 0, max: 5, fractionDigits: 4 }),
    tokens: tokenUsage(),
  };
}

function retryRecord(id: RunId): MetricRecord {
  return {
    kind: 'retry',
    at: faker.date.recent().toISOString(),
    runId: id,
    location: { phase: 'describing' },
    reason: faker.lorem.sentence(),
  };
}
