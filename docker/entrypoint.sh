#!/usr/bin/env bash
# Container setup: git identity and volume permissions.
set -euo pipefail

# Tracker and code-host credentials (JIRA_*, GH_TOKEN, ...) are checked by the
# orchestrator at startup, only for the vendors factory.config.yml actually uses.
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY" >&2
  exit 1
fi

git config --global user.name "${GIT_AUTHOR_NAME:-Software Factory}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-factory@users.noreply.github.com}"
git config --global init.defaultBranch main
# Git auth is not configured here: each code host vendor passes credentials and
# the SSH-to-HTTPS rewrite to the orchestrator's own clone and push commands only
# (see orchestrator/src/hosts/git.ts), so nothing the agent can read holds them.

# Commits made by the agent user use the same identity (passed via sudo env_keep).
export GIT_COMMITTER_NAME="${GIT_AUTHOR_NAME:-Software Factory}" GIT_COMMITTER_EMAIL="${GIT_AUTHOR_EMAIL:-factory@users.noreply.github.com}"
export GIT_AUTHOR_NAME="$GIT_COMMITTER_NAME" GIT_AUTHOR_EMAIL="$GIT_COMMITTER_EMAIL"

# Volumes created by older images: /data must be private to the orchestrator,
# and /work shared with the agent user through the `work` group.
chmod 700 /data
chgrp work /work && chmod 2775 /work
find /work -mindepth 1 -maxdepth 1 -type d -user "$(id -u)" -exec chgrp work {} + -exec chmod 2775 {} +
mkdir -p /work/.agent-runs && chmod 2770 /work/.agent-runs
umask 002

exec "$@"
