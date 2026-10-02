export interface AgentRunInput {
  cwd: string;
  prompt: string;
  /**
   * The git repository `cwd` lives in, when that's not `cwd` itself — i.e.
   * `cwd` is a secondary worktree (e.g. a per-run `.sdlc/<runId>/workspace`
   * dir) whose `.git` is a *file* pointing at an absolute host path under
   * `repoRoot/.git/worktrees/...`, outside `cwd`. DockerCliProvider needs
   * this to bind-mount the whole repo rather than just `cwd`, so that
   * pointer still resolves inside the container. Omit it when `cwd` IS the
   * repo root (nothing outside it for git to need).
   */
  repoRoot?: string;
}

export interface AgentRunResult {
  success: boolean;
  output: string;
}

export interface AgentProvider {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
