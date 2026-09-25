export interface AgentRunInput {
  cwd: string;
  prompt: string;
}

export interface AgentRunResult {
  success: boolean;
  output: string;
}

export interface AgentProvider {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
