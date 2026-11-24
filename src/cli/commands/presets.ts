import type { Command } from 'commander';

import type { JigOperations, Preset } from '../../app/api.js';
import { type FailureOutput, withErrorHandling } from '../with-error-handling.js';

export function registerPresetsCommand(
  program: Command,
  listPresets: JigOperations['listPresets'],
  failureOutput?: FailureOutput,
): void {
  program
    .command('presets')
    .description('List the presets --preset can name, and where each is read from')
    .action(
      withErrorHandling(async () => {
        const presets = await listPresets();
        return presets.map((listed) => {
          console.log(describePresets(listed));
        });
      }, failureOutput),
    );
}

export function describePresets(presets: Preset[]): string {
  if (presets.length === 0) return 'No presets found.';
  return presets
    .map(({ name, label, description }) => {
      const line = `${name.padEnd(20)} ${label.source.padEnd(10)} ${label.location}`;
      return description ? `${line}\n  ${description}` : line;
    })
    .join('\n');
}
