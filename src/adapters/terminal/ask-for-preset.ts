import { select } from '@inquirer/prompts';

import type { Preset, PresetPick } from '../../config/presets.js';
import { askInTerminal, PROCESS_TERMINAL, type Terminal } from './terminal.js';

interface PresetChoice {
  name: string;
  value: PresetPick;
  description?: string;
}

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

function choiceFor({ name, label, description }: Preset): PresetChoice {
  const choice = label.starter ? name : `${name} (${label.source})`;
  return { name: choice, value: { kind: 'preset', name }, description };
}
