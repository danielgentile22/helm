# HELM chat brain — the existing Next app (/chat + /api/chat) plus the three
# daemons it needs on an always-on Fly VM: claude CLI, tailscaled, syncthing.
# The Mac keeps running full HELM; this image is chat-only. See docs/fly-deploy.md.

# --- build the Next app ------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# config.ts reads VAULT_ROOT at import time and throws if unset — give it the
# prod value so `next build` can load the server routes. The dir need not exist
# at build; it's the runtime mount.
ENV VAULT_ROOT=/data/vault
RUN npm run build

# --- runtime: app + daemons --------------------------------------------------
FROM node:22-bookworm-slim
WORKDIR /app

# claude CLI (the chat brain), tailscale (tailnet), syncthing (vault sync).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg iproute2 syncthing \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
      > /usr/share/keyrings/tailscale-archive-keyring.gpg \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list \
      > /etc/apt/sources.list.d/tailscale.list \
 && apt-get update && apt-get install -y --no-install-recommends tailscale \
 && npm install -g @anthropic-ai/claude-code \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# ponytail: copy the whole built app (incl. dev deps) — simplest correct thing.
# Switch to `output: 'standalone'` + a slim copy if image size ever bites.
COPY --from=build /app ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV VAULT_ROOT=/data/vault \
    HUD_TZ=America/New_York \
    CLAUDE_BIN=claude \
    NODE_ENV=production

# No EXPOSE / public port: the app is reachable only over the tailnet (3107).
ENTRYPOINT ["/entrypoint.sh"]
