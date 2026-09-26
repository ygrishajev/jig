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
# Pre-create opencode's config dir owned by `node`. Bind-mounting a single
# file (the auth.json mount) auto-creates missing parent directories owned by
# root, which would otherwise block opencode from writing sibling dirs (e.g.
# its `repos` cache) alongside the mounted file.
RUN mkdir -p /home/node/.local/share/opencode && chown -R node:node /home/node/.local
USER node
