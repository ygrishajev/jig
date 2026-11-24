import { confirm, input, password, select } from '@inquirer/prompts';

import type { EnteredCredential, MissingCredential } from '../../config/agent-policy.js';
import { CREDENTIALS_FILE } from '../local-store/credentials-file.js';
import { AGENTS } from '../sandcastle/agents.js';
import { askInTerminal, PROCESS_TERMINAL, type Terminal } from './terminal.js';

/** A credential typed by the operator, who decides whether it is kept for later runs. */
export function askForCredential(
  missing: MissingCredential,
  terminal: Terminal = PROCESS_TERMINAL,
): Promise<EnteredCredential | undefined> {
  return askInTerminal(terminal, (open) => ask(missing, open));
}

async function ask(
  { provider, keys }: MissingCredential,
  terminal: Terminal,
): Promise<EnteredCredential> {
  const { credentialHelp, credentialIsSecret } = AGENTS[provider];
  const message = `${provider} needs a credential (${credentialHelp})`;
  const name =
    keys.length === 1
      ? keys[0]
      : await select<string>({ message, choices: keys.map((value) => ({ value })) }, terminal);
  const prompt = {
    message: keys.length === 1 ? `${message} — ${name}:` : `${name}:`,
    validate: (value: string) =>
      unsavableProblem(value) ?? AGENTS[provider].credentialProblem(value.trim()) ?? true,
  };
  const value = await (credentialIsSecret
    ? password({ ...prompt, mask: true }, terminal)
    : input(prompt, terminal));
  const save = await confirm(
    {
      message: `Save it to ${CREDENTIALS_FILE} for later runs? It is ignored by git and only you can read it. Otherwise it lasts for this command only.`,
      default: true,
    },
    terminal,
  );
  return { name, value: value.trim(), save };
}

function unsavableProblem(value: string): string | undefined {
  if (!value.trim()) return 'Enter a value.';
  return /["\\\r\n]/.test(value) ? 'A credential cannot hold a quote or a backslash.' : undefined;
}
