# syntax=docker/dockerfile:1
# Build context is the repo root: docker build -f docker/Dockerfile .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim

ARG TARGET_REPO=""
ARG CLAUDE_CHANNEL=stable
ARG OPENSPEC_VERSION=1.14.0

# TARGET_REPO is baked in; a runtime env var of the same name overrides it.
ENV TARGET_REPO=${TARGET_REPO} \
    DATA_DIR=/data \
    TZ=Europe/London \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq gh sudo tini tzdata procps util-linux \
      iptables ipset iproute2 dnsutils aggregate \
      postgresql-client redis-tools \
  && rm -rf /var/lib/apt/lists/*

# runner: owns secrets, state and all GitHub writes. agent: runs Claude, installs and gates.
# Both share the `work` group so they can hand worktrees back and forth.
RUN groupadd --gid 10010 work \
  && useradd --uid 10001 --gid work --create-home --shell /usr/sbin/nologin runner \
  && useradd --uid 10002 --gid work --create-home --shell /bin/bash agent \
  && corepack enable \
  && git config --system safe.directory '*' \
  && git config --system init.defaultBranch main

# Claude Code (native install) and the OpenSpec CLI live under /home/agent/.local, which is a
# volume, so the `update` job can upgrade and roll them back without rebuilding the image.
COPY --chown=agent:work docker/claude-settings.json /home/agent/.claude/settings.json
RUN su agent -s /bin/bash -c "curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CHANNEL}" \
  && su agent -s /bin/bash -c "npm config set prefix /home/agent/.local && npm install -g @fission-ai/openspec@${OPENSPEC_VERSION}" \
  && su agent -s /bin/bash -c "corepack prepare pnpm@latest --activate" \
  && su agent -s /bin/bash -c "/home/agent/.local/bin/claude --version && /home/agent/.local/bin/openspec --version"

COPY --from=build /src/node_modules /opt/runner/node_modules
COPY --from=build /src/dist /opt/runner/dist
COPY package.json /opt/runner/package.json
COPY docker/ /opt/runner/docker/
RUN install -m 0440 /opt/runner/docker/sudoers.agent /etc/sudoers.d/agent \
  && visudo -cf /etc/sudoers.d/agent \
  && chmod 0755 /opt/runner/docker/*.sh /opt/runner/dist/cli.js \
  && ln -s /opt/runner/dist/cli.js /usr/local/bin/pez-bot \
  && mkdir -p /data

HEALTHCHECK --interval=5m --timeout=30s --start-period=10m --retries=2 \
  CMD ["node", "/opt/runner/dist/cli.js", "healthcheck"]

# Starts as root only to set up the firewall; entrypoint.sh drops to `runner`.
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/runner/docker/entrypoint.sh"]
CMD ["daemon"]
