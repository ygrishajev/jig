#!/bin/sh
# $HOME is a fresh, empty tmpfs for every run (see SANDBOX_HOME in
# docker-cli.ts) — no host-backed directory for sdlc to pre-populate a
# credentials file into. Instead, a provider that needs one passes its
# contents through an env var, and this entrypoint (running as the
# container's own user, so ordinary ownership rules apply with no uid
# matching required) materializes it on disk before exec'ing the real
# command.
set -e

if [ -n "$OPENCODE_AUTH_JSON" ]; then
  mkdir -p "$HOME/.local/share/opencode"
  printf '%s' "$OPENCODE_AUTH_JSON" > "$HOME/.local/share/opencode/auth.json"
fi

exec "$@"
