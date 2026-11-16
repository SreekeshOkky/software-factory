# Software factory: Claude Code CLI + gh + Playwright, driven by the orchestrator.
FROM node:22-bookworm

ARG CLAUDE_CODE_VERSION=latest
ARG PLAYWRIGHT_MCP_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DISABLE_AUTOUPDATER=1

# git, gh CLI, tini for signal handling, jq for debugging
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates jq tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Claude Code + Playwright MCP, then Chromium (and its system deps) matching
# the Playwright version Playwright MCP bundles.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
 && cd "$(npm root -g)/@playwright/mcp" && npx --no-install playwright install --with-deps chromium \
 && chmod -R a+rwx /ms-playwright

# Non-root user (Claude Code refuses some modes as root, and it's safer).
RUN useradd -m -s /bin/bash factory && mkdir -p /data /work && chown factory:factory /data /work

# Orchestrator
WORKDIR /app
COPY orchestrator/package.json orchestrator/package-lock.json* ./orchestrator/
RUN cd orchestrator && (npm ci || npm install)
COPY orchestrator ./orchestrator
RUN cd orchestrator && npm run build
COPY factory.config.yml ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Agents and skills become the factory user's user-level Claude config, so they
# apply to every cloned repo without being committed to it.
COPY --chown=factory:factory docker/claude-home/ /home/factory/.claude/
COPY --chown=factory:factory plugins/factory/skills/ /home/factory/.claude/skills/

USER factory
VOLUME ["/data", "/work"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/orchestrator/dist/index.js"]
