# Software factory: Claude Code CLI + gh + Playwright, driven by the orchestrator.
FROM node:22-bookworm

ARG CLAUDE_CODE_VERSION=latest
ARG PLAYWRIGHT_MCP_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DISABLE_AUTOUPDATER=1

# git, gh CLI, tini for signal handling, jq for debugging
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates jq tini sudo procps \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Claude Code + Playwright MCP, then Chromium (and its system deps) matching
# the Playwright version Playwright MCP bundles.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
 && cd "$(npm root -g)/@playwright/mcp" && npx --no-install playwright install --with-deps chromium \
 && chmod -R a+rwx /ms-playwright

# Two non-root users. `factory` runs the orchestrator and holds the GitHub and
# Jira tokens. `agent` runs everything that executes repo code or model output
# (Claude, install, tests, the app, git in workspaces). A different uid can't
# read the orchestrator's /proc/<pid>/environ or the 0700 /data volume. Both
# share the `work` group for /work. `factory` may run only agent-exec as `agent`.
RUN groupadd work \
 && useradd -m -s /bin/bash -G work factory \
 && useradd -m -s /bin/bash -G work agent \
 && mkdir -p /data /work && chown factory:factory /data && chmod 700 /data \
 && chown factory:work /work && chmod 2775 /work
COPY docker/agent-exec /usr/local/bin/agent-exec
COPY docker/sudoers-factory /etc/sudoers.d/factory
RUN chmod 755 /usr/local/bin/agent-exec && chmod 440 /etc/sudoers.d/factory && visudo -cf /etc/sudoers.d/factory

# Orchestrator
WORKDIR /app
COPY orchestrator/package.json orchestrator/package-lock.json* ./orchestrator/
RUN cd orchestrator && (npm ci || npm install)
COPY orchestrator ./orchestrator
RUN cd orchestrator && npm run build
COPY factory.config.yml ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && printf '#!/bin/sh\nexec node /app/orchestrator/dist/status.js "$@"\n' > /usr/local/bin/status && chmod +x /usr/local/bin/status

# Agents and skills become the agent user's user-level Claude config, so they
# apply to every cloned repo without being committed to it.
COPY --chown=agent:agent docker/claude-home/ /home/agent/.claude/
COPY --chown=agent:agent plugins/factory/skills/ /home/agent/.claude/skills/
# Claude Code's full session transcripts land in projects/ (a volume). Skip
# first-run onboarding. `safe.directory`: the agent runs git in clones the
# factory created.
RUN mkdir -p /home/agent/.claude/projects \
 && echo '{"hasCompletedOnboarding": true}' > /home/agent/.claude.json \
 && chown -R agent:agent /home/agent \
 && su agent -c "git config --global safe.directory '*' && git config --global init.defaultBranch main"
ENV AGENT_USER=agent

USER factory
VOLUME ["/data", "/work", "/home/agent/.claude/projects"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/orchestrator/dist/index.js"]
