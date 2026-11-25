import type { MetricsSummary } from '../domain/metrics.js';

/** The summary line of a run that has taken a step; a run that has not taken one has none. */
export function progressSummary(summary: MetricsSummary): string | undefined {
  return summary.steps > 0 ? formatSummary(summary) : undefined;
}

/** One line for a PR footer or a status line, e.g. "2 slices · 1 review round · 412k tokens · $1.84 · 18m 3s". */
export function formatSummary(summary: MetricsSummary): string {
  const tokens =
    summary.tokens.input +
    summary.tokens.output +
    summary.tokens.cacheRead +
    summary.tokens.cacheWrite;
  return [
    plural(summary.slicesCommitted, 'slice'),
    plural(summary.reviewRounds, 'review round'),
    `${compact(tokens)} tokens`,
    `$${summary.costUsd.toFixed(2)}`,
    duration(summary.durationMs),
    ...(summary.retries > 0 ? [plural(summary.retries, 'retry', 'retries')] : []),
  ].join(' · ');
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function compact(count: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
    .format(count)
    .toLowerCase();
}

function duration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
