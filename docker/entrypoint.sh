#!/usr/bin/env bash
# Container setup that needs runtime secrets: git identity and GitHub auth.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${JIRA_BASE_URL:?JIRA_BASE_URL is required}"
: "${JIRA_EMAIL:?JIRA_EMAIL is required}"
: "${JIRA_API_TOKEN:?JIRA_API_TOKEN is required}"
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY" >&2
  exit 1
fi

git config --global user.name "${GIT_AUTHOR_NAME:-Software Factory}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-factory@users.noreply.github.com}"
git config --global init.defaultBranch main
# Repos are listed with SSH URLs; clone over HTTPS with the token instead, so
# the container needs no SSH keys.
git config --global url."https://github.com/".insteadOf "git@github.com:"
gh auth setup-git

# Skip Claude Code's first-run onboarding in a headless container.
if [[ ! -f "$HOME/.claude.json" ]]; then
  echo '{"hasCompletedOnboarding": true}' > "$HOME/.claude.json"
fi

exec "$@"
