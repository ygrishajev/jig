# Spike image: the planned two-layer shape collapsed into one file.
# Base + toolchain first (UID-independent, cacheable), then UID, then agents.
FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl jq ripgrep ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

ARG CLAUDE_VERSION=latest
ARG OPENCODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} opencode-ai@${OPENCODE_VERSION} \
    && rm -rf /tmp/opencode

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
