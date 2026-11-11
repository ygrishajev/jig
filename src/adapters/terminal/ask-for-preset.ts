import { select } from '@inquirer/prompts';

import type { Preset, PresetName } from '../../config/presets.js';
import { askInTerminal, PROCESS_TERMINAL, type Terminal } from './terminal.js';

interface PresetChoice {
  name: string;
  value: PresetPick;
  description?: string;
}

/** A preset the operator picked, or the project's config with no preset over it. */
export type PresetPick = { kind: 'preset'; name: PresetName } | { kind: 'none' };

/** The preset the operator picks; `undefined` when nobody can answer or they cancel. */
export function askForPreset(
  presets: Preset[],
  terminal: Terminal = PROCESS_TERMINAL,
): Promise<PresetPick | undefined> {
  return askInTerminal(terminal, (open) =>
    select<PresetPick>(
      {
        message: 'Which preset?',
        choices: [
          { name: 'jig.config.json (no preset)', value: { kind: 'none' } },
          ...presets.map(choiceFor),
        ],
      },
      open,
    ),
  );
}

function choiceFor({ name, source, description }: Preset): PresetChoice {
  const label = source === 'builtin' ? name : `${name} (${source})`;
  return { name: label, value: { kind: 'preset', name }, description };
}
