# Minimal sandbox for running the agentic CLI unattended
# (--dangerously-skip-permissions is only ever used inside this container —
# never on the host, see src/cli/run-context.ts).
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code opencode-ai

# claude refuses --dangerously-skip-permissions when run as root/sudo, so the
# agent runs as the non-root `node` user node:22-slim already ships with.
WORKDIR /workspace
RUN chown node:node /workspace
USER node
