import { z } from 'zod';

/** The jobs an agent does in a run; each can be served by a different agent and model. */
export const agentRoleSchema = z.enum(['planner', 'implementer', 'reviewer', 'describer']);
export type AgentRole = z.infer<typeof agentRoleSchema>;

/** One value for every role; a role added to `agentRoleSchema` fails to compile here until it has one. */
export function byRole<T>(valueFor: (role: AgentRole) => T): Record<AgentRole, T> {
  return {
    planner: valueFor('planner'),
    implementer: valueFor('implementer'),
    reviewer: valueFor('reviewer'),
    describer: valueFor('describer'),
  };
}
