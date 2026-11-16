# Software factory

A Docker container that takes work from Jira and drives it through to a verified feature, using Claude Code agents.

```
Jira "To Do" ──▶ build (red → green → screenshots) ──▶ PR + Jira update ──▶ review agent comments
                                                                                   │
Jira verdict table ◀── verify in browser ◀── Jira "Done" ◀── human merges the PR ◀──┘
```

The factory works with any repo. Everything repo-specific lives in the target repo, in files the **`onboard-repo`** skill writes:
- `CLAUDE.md`: project rules
- `factory.yml`: commands and ticket modes
- `docs/app-navigation.md`: navigation notes for the verifier
- a test harness

## How a ticket flows

| Trigger (polled every 60s) | What happens | Who decides |
| --- | --- | --- |
| Ticket in **To Do** with label `factory-enabled` | The ticket moves to In Progress. The builder works on a fresh branch `factory/KEY` and commits failing tests (`Factory-Phase: red`), then the implementation. The factory then **checks the TDD claim itself**: tests must fail at the red commit and pass at HEAD, and no protected path may change. It starts the app, screenshots each criterion and opens a PR. The screenshots are attached to Jira, and the ticket moves to In Review. | Code. The agent only writes code. |
| PR open | The `pr-reviewer` agent reads the ticket, the diff and CLAUDE.md. It returns comments as JSON, which the factory posts as a `COMMENT` review. | The agent comments. It never approves. |
| PR **merged** by you | The ticket moves to **Done**. | You |
| Ticket in **Done** | The `ticket-verifier` agent (see [the article](jira-ticket-to-playwright-test.md)) checks every criterion on `main` in a real browser. It sees no code. A PASS/FAIL/UNTESTABLE table and screenshots go to Jira. If `regression_tests: true` and everything passes, a Playwright regression-test PR follows. | You read the verdict. |

Labels track progress: `factory-building` → `factory-pr-open` → `factory-reviewed` → `factory-merged` → `factory-verified` (or `factory-verify-failed`).

Any failure, including a missing red commit, tests passing at red, a protected-path change or an agent giving up, adds **`factory-blocked`** with a Jira comment explaining why. **Remove the label to retry.**

### Who can do what

| Agent | Tools | Can't |
| --- | --- | --- |
| `ticket-builder` | Read/Edit/Write/Bash/Grep/Glob, Playwright | `git push` and `gh` are denied. It has no GitHub or Jira token in its environment, and a protected-path change blocks the ticket. |
| `evidence-capture` | Playwright only | Edit anything |
| `pr-reviewer` | Read/Grep/Glob | Run commands, post anything (the factory posts for it) |
| `ticket-verifier` | Playwright only, run from an empty directory | See source code, the diff or the PR |

## Setup

### 1. Jira
- **Workflow statuses** named in `factory.config.yml` → `statuses`. `review` is optional.
- **Factory account:** a dedicated Jira user with an [API token](https://id.atlassian.com/manage-profile/security/api-tokens). It needs browse, transition, comment, edit labels and add attachments on the configured projects.
- **Opt-in label:** create tickets with the `factory-enabled` label and clear acceptance criteria in the description.
- Optional: set `JIRA_ROVO_MCP=true` to also give agents the Atlassian Rovo MCP server. The ticket text is always passed in the prompt, so this is extra. An org admin has to [enable API-token auth for Rovo MCP](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/configuring-authentication-via-api-token).

### 2. GitHub
- `GH_TOKEN`: clone, push and create PRs on the target repos (fine-grained: Contents and Pull requests read/write).
- `GH_REVIEWER_TOKEN`: a second bot account for reviews, recommended. Without it, reviews post as the PR author.

### 3. Claude
Use either:
- `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, which uses your subscription; or
- `ANTHROPIC_API_KEY`.

### 4. Register repos
In `factory.config.yml`:
```yaml
repos:
  - name: portfolio
    git: git@github.com:SreekeshOkky/portfolio.git
    base_branch: main
    jira: { project: PORT }   # add `component: web` to route one project to several repos
```

### 5. Onboard each repo
Run the `onboard-repo` skill on the repo, either in Claude Code on your machine (`/onboard-repo`) or in the container. It does the following:
1. Surveys the repo's conventions.
2. Writes `CLAUDE.md`, `factory.yml` and `docs/app-navigation.md`.
3. Adds a test harness if the repo has none.
4. Self-checks the commands.
5. Opens an onboarding PR.

**Review that PR carefully.** Its `factory.yml` commands run in the container, and its `CLAUDE.md` is the rulebook for every ticket.

The skill lives in `plugins/factory/`, and the Docker image copies it in.

### 6. Run
```bash
cp .env.example .env   # fill it in
```
```bash
DRY_RUN=true docker compose up --build   # logs what it would do, changes nothing
```
```bash
docker compose up -d --build && docker compose logs -f
```

Run one tick and exit (useful for debugging):
```bash
docker compose run --rm factory node /app/orchestrator/dist/index.js --once
```

The `/data` volume holds `state.json` (per-ticket PR, red/green SHAs, cost) and `runs/` (every agent's JSON transcript).

## Development
```bash
cd orchestrator && npm install && npm test && npm run typecheck
```

Layout:
- `orchestrator/src/index.ts`: the poll loop
- `stages/*`: one file per lifecycle step
- `redgreen.ts`: the TDD check
- `repo.ts`: the `factory.yml` contract
- `jira.ts`, `github.ts`, `claude.ts`: clients
- `docker/claude-home/`: the agents and the `red-green` skill, installed as the container user's `~/.claude`

## Known limits
- **One ticket at a time.** The dev server port and the preview data are shared.
- **Reviews run once per PR.** New pushes after the review don't trigger another one.
- **The verifier runs after merge, against `main`,** as requested. The article argues for verifying a preview *before* merge. Moving the verify stage before the human gate is a small change in `index.ts`.
- **Screenshots are committed to the PR branch** under `.factory/evidence/KEY/`. GitHub has no API for uploading images, so this is how the PR shows them.
