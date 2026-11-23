import { Result } from 'better-result';
import { Command } from 'commander';

import { defaultLogFormat } from '../../adapters/logging/create-logger.js';
import { discoverPresets, type Preset } from '../../config/presets.js';
import type { ExceptionDetails } from '../../ports/exception-details.js';
import { withApp } from '../with-app.js';
import { withErrorHandling } from '../with-error-handling.js';

export function registerPresetsCommand(program: Command, exceptionDetails: ExceptionDetails): void {
  program
    .command('presets')
    .description('List the presets --preset can name, and where each is read from')
    .action(
      withErrorHandling(async () => {
        return withApp({ logFormat: defaultLogFormat() }, async (app) => {
          const presets = discoverPresets(app.cradle.presetSource);
          if (presets.isErr()) return Result.err(presets.error);
          console.log(describePresets(presets.value));
          return Result.ok();
        });
      }, exceptionDetails),
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
