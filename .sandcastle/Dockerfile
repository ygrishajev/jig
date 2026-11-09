FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl jq ripgrep ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

# --- project toolchain (yours: what setupCommand and verifyCommand need) ---
# --- end project toolchain ---

ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
