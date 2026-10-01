# Minimal sandbox for running the agentic CLI unattended
# (--dangerously-skip-permissions is only ever used inside this container —
# never on the host, see src/cli/run-context.ts).
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code opencode-ai

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace

# claude refuses --dangerously-skip-permissions when run as root/sudo. sdlc
# always overrides this at runtime with the host's own uid, and gives $HOME
# (see SANDBOX_HOME in docker-cli.ts) its own tmpfs, so neither this workdir
# nor this user's uid are actually load-bearing when run through sdlc —
# `node` is just a safe non-root default for running this image directly.
USER node
ENTRYPOINT ["/entrypoint.sh"]
