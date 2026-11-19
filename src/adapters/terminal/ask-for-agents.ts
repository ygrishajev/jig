import { checkbox, input, select } from '@inquirer/prompts';

import { AGENT_NAMES, type AgentChoice, type AgentName } from '../../config/agent-policy.js';
import type { AgentRole } from '../../domain/agent-role.js';
import { AGENTS, modelProblem } from '../sandcastle/agents.js';
import { askInTerminal, PROCESS_TERMINAL, type Terminal } from './terminal.js';

/** The agent the operator picks for each role; `undefined` when nobody can answer or they cancel. */
export function askForAgents(
  roles: AgentRole[],
  terminal: Terminal = PROCESS_TERMINAL,
): Promise<Partial<Record<AgentRole, AgentChoice>> | undefined> {
  return askInTerminal(terminal, (open) => ask(roles, open));
}

async function ask(
  roles: AgentRole[],
  terminal: Terminal,
): Promise<Partial<Record<AgentRole, AgentChoice>>> {
  const agents = await chooseAgents(terminal);
  const assigned: Partial<Record<AgentRole, AgentChoice>> = {};
  for (const role of roles) {
    assigned[role] = agents.length === 1 ? agents[0] : await pickForRole(role, agents, terminal);
  }
  return assigned;
}

async function chooseAgents(terminal: Terminal): Promise<AgentChoice[]> {
  const providers = await checkbox<AgentName>(
    {
      message: 'Which agents?',
      choices: AGENT_NAMES.map((value) => ({ value })),
      required: true,
    },
    terminal,
  );
  const agents: AgentChoice[] = [];
  for (const provider of providers) {
    const models = await chooseModels(provider, terminal);
    agents.push(...models.map((model) => ({ provider, model })));
  }
  return agents;
}

async function chooseModels(provider: AgentName, terminal: Terminal): Promise<string[]> {
  const options: string[] = AGENTS[provider].modelOptions;
  if (options.length === 0) return [await typeModel(provider, terminal)];
  const picked = await checkbox<string | undefined>(
    {
      message: `Which ${provider} models?`,
      choices: [
        ...options.map((value) => ({ value })),
        { name: 'Other (type a name)', value: undefined },
      ],
      required: true,
    },
    terminal,
  );
  const models = picked.filter((model) => model !== undefined);
  if (picked.includes(undefined)) models.push(await typeModel(provider, terminal));
  return [...new Set(models)];
}

async function typeModel(provider: AgentName, terminal: Terminal): Promise<string> {
  const typed = await input(
    {
      message: `Which ${provider} model?`,
      validate: (model) =>
        model.trim() ? (modelProblem(provider, model.trim()) ?? true) : 'Type a model name.',
    },
    terminal,
  );
  return typed.trim();
}

function pickForRole(
  role: AgentRole,
  agents: AgentChoice[],
  terminal: Terminal,
): Promise<AgentChoice> {
  return select<AgentChoice>(
    {
      message: `Which model for the ${role} step?`,
      choices: agents.map((value) => ({ name: labelOf(value), value })),
    },
    terminal,
  );
}

function labelOf({ provider, model }: AgentChoice): string {
  return `${provider} / ${model}`;
}
