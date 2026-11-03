export interface ToolchainPromptInput {
  dockerfile: string;
  setupCommand?: string;
  verifyCommand?: string;
  previousFailure?: string;
}

export function toolchainPrompt(input: ToolchainPromptInput): string {
  const { dockerfile, setupCommand, verifyCommand, previousFailure } = input;
  return [
    'You are setting up the sandbox an automated SDLC pipeline will work in for this repository.',
    'The sandbox is a Docker image built from the Dockerfile below. It already has Node.js 22,',
    'git, curl, jq and ripgrep on Debian bookworm; you are running inside the current version.',
    '',
    'Explore the repository — manifests, lockfiles, version files (.nvmrc, .tool-versions,',
    'pyproject.toml, go.mod, …), CI workflows and the README — to find what it needs to install',
    'its dependencies and to run its checks.',
    '',
    '--- DOCKERFILE ---',
    dockerfile,
    '--- END DOCKERFILE ---',
    '',
    'Produce:',
    '- "toolchain": the Dockerfile lines that install what is missing (RUN instructions, run as',
    '  root, before the agent user is created). Empty when nothing is missing. Do not repeat what',
    "  the base already has, and do not install the repository's own dependencies here.",
    `- "setupCommand": the command that installs the repository's dependencies inside the`,
    `  sandbox, run from the repository root${setupCommand ? ` (currently "${setupCommand}" — keep it unless it is wrong)` : ''}.`,
    `- "verifyCommand": the command that checks a change — tests, and lint or typecheck if the`,
    `  repository has them${verifyCommand ? ` (currently "${verifyCommand}" — keep it unless it is wrong)` : ''}.`,
    ...(previousFailure
      ? [
          '',
          'The previous attempt did not work. Fix what this output shows:',
          '--- FAILURE ---',
          previousFailure,
          '--- END FAILURE ---',
        ]
      : []),
    '',
    'Do not change any files. Respond with JSON matching:',
    '{ "toolchain": string, "setupCommand": string, "verifyCommand": string }.',
  ].join('\n');
}
