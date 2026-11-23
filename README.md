# Software factory

A Docker container that takes work from Jira and drives it through to a verified feature, using Claude Code agents.

```
Jira "To Do" ──▶ build (red → green → screenshots) ──▶ PR + Jira update ──▶ review agent comments
                                                                                   │
Jira verdict table ◀── verify in browser ◀── Jira "Done" ◀── human merges the PR ◀──┘
```

The factory works with any repo. Everything repo-specific lives in the target repo, in files the **`onboard-repo`** skill writes:
- `CLAUDE.md`: project rules
- `factory.yml`: commands and ticket modes (see [the contract](#factoryyml-per-repo))
- `docs/app-navigation.md`: navigation notes for the verifier
- a test harness

Agents only write code, comments and verdicts. Plain TypeScript code makes every workflow decision: Jira transitions, labels, comments, pushes and PRs.

## How a ticket flows

Every poll (60s by default), for each repo, the factory runs these stages in order: close merged PRs, verify Done tickets, review open PRs, then build **at most one** new ticket. Stages run one at a time, and each gets a fresh clone of the repo.

| Trigger | What happens | Who decides |
| --- | --- | --- |
| Ticket in **To Do** with label `factory-enabled` (highest priority, then oldest, first) | The ticket moves to In Progress. If the repo has no `factory.yml`, the ticket is blocked as not onboarded. The builder works on a fresh branch `factory/KEY` and commits failing tests (`Factory-Phase: red`), then the implementation. The factory then **checks the TDD claim itself**: exactly one red commit, tests must fail at it and pass at HEAD, and no protected path may change. If tests from the red commit were edited later, the PR and Jira comment flag it for a human. The factory starts the app, the `evidence-capture` agent screenshots each criterion, and the factory opens a PR. The screenshots are attached to Jira, and the ticket moves to In Review. | Code. The agent only writes code. |
| PR open | The `pr-reviewer` agent reads the ticket, the diff and CLAUDE.md. It returns comments and a criteria-coverage table as JSON, which the factory posts as a `COMMENT` review. Comments on lines outside the diff go into the review body. | The agent comments. It never approves. |
| PR **merged** by you | The ticket moves to **Done**. A PR closed without merging blocks the ticket. | You |
| Ticket in **Done** | The `ticket-verifier` agent checks every criterion on the base branch in a real browser. It sees no code. A PASS/FAIL/UNTESTABLE table and screenshots go to Jira. If `regression_tests: true` and everything passes, the builder writes Playwright regression tests on `factory/KEY-regression`, and the factory opens a PR once the suite passes. | You read the verdict. |

Any `factory-enabled` ticket in Done gets verified, including one you moved there by hand.

Labels track progress: `factory-building` → `factory-pr-open` → `factory-reviewed` → `factory-merged` → `factory-verified` (or `factory-verify-failed`).

Any failure adds **`factory-blocked`** with a Jira comment explaining why. Examples: not onboarded, no red commit or more than one, tests passing at red or failing at HEAD, a protected-path change, the app not starting, an agent giving up, or unparseable agent output.

**To retry:** fix the cause and remove `factory-blocked`.
- **A failed build** has already moved the ticket to In Progress, so also move it back to **To Do**. The rebuild force-pushes `factory/KEY`.
- **A review, verify or close failure** retries as soon as the label is gone. A PR closed without merging blocks again until you reopen it.

For every case (what the agents read from a ticket, every block reason, handling review comments and verifier verdicts, rebuilding a merged ticket and edge cases), see [docs/ticket-lifecycle.md](docs/ticket-lifecycle.md).

### Who can do what

| Agent | Runs in | Tools | Can't |
| --- | --- | --- | --- |
| `ticket-builder` | The clone, on `factory/KEY` | Read/Edit/Write/Bash/Grep/Glob, the `red-green` skill, Playwright, and the tracker's MCP server if it has one (Rovo for Jira, if enabled) | `git push`, `gh`, `npm publish`, `vercel` and reading `.env*` are denied. It has no code-host or tracker token in its environment, and a protected-path change blocks the ticket. |
| `evidence-capture` | An empty screenshots directory | Playwright only | Edit anything |
| `pr-reviewer` | A clone of the PR branch | Read/Grep/Glob | Run commands, post anything (the factory posts for it) |
| `ticket-verifier` | An empty screenshots directory | Playwright only | See source code, the diff, the PR or the builder's summary |

Every prompt wraps the ticket text as data and tells the agent to ignore instructions inside it.

### Security model

**Who can trigger code execution:** anyone who can create or edit a Jira ticket with the `factory-enabled` label. The builder runs shell commands, and the ticket text is untrusted input, so treat the label as commit access.

The container separates two Unix users:

| User | Runs | Holds |
| --- | --- | --- |
| `factory` | The orchestrator: tracker and code-host API calls, the network clone, and the final push | `GH_TOKEN`, `GH_REVIEWER_TOKEN`, `JIRA_API_TOKEN`, and `/data` (mode 0700) |
| `agent` | Everything that runs model output or repo code: Claude, `install`, tests, the app, and git inside workspaces | Only the Claude token, through sudo's `env_keep` |

How the separation holds:
- **Running agent commands:** the factory starts them with `sudo -u agent /usr/local/bin/agent-exec`. sudo resets the environment, and that one rule is all the factory may run as `agent`. The agent itself can't use sudo.
- **The tokens:** a different uid can't read the orchestrator's `/proc/<pid>/environ`, so the agent can't see the factory's tokens.
- **Cloning:** the factory clones from the code host, then the agent clones that local copy, so the agent's repo never had the token. The token reaches only the factory's own `git clone` and `git push`, as environment variables (no git config file holds it).
- **Pushing:** the agent exports its branch as a `git bundle`. The factory fetches the bundle into its own clean repo and pushes from there, so hooks or config planted in the agent's `.git` never run with the token. Only `factory/*` branches can be pushed.
- **Protected paths:** `.env`, `.env.*` and `factory.yml` are always protected, on top of the repo's own `protected_paths`.

**Still open:**
- Agents have unrestricted outbound network access, so they could send repo contents elsewhere. Use an egress proxy if that matters to you.
- The agent can read its own Claude token.
- If Rovo MCP is on, the builder's MCP config holds the Jira credentials for the length of its run.
- Commands in `factory.yml` run as `agent` and are trusted, because a human reviews them in the onboarding PR.

## Setup

### 1. Jira
- **Workflow statuses** named in `factory.config.yml` → `statuses`. `review` is optional; without it, tickets stay In Progress while the PR is open.
- **Factory account:** a dedicated Jira Cloud user with an [API token](https://id.atlassian.com/manage-profile/security/api-tokens). It needs browse, transition, comment, edit labels and add attachments on the configured projects.
- **Opt-in label:** create tickets with the `factory-enabled` label and clear acceptance criteria in the description.
- Optional: set `JIRA_ROVO_MCP=true` to also give the builder the Atlassian Rovo MCP server, for linked issues and comments. The ticket text is always passed in the prompt, so this is extra. An org admin has to [enable API-token auth for Rovo MCP](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/configuring-authentication-via-api-token).

### 2. GitHub
- `GH_TOKEN`: clone, push and create PRs on the target repos (fine-grained: Contents and Pull requests read/write).
- `GH_REVIEWER_TOKEN`: a second bot account for reviews, recommended. Without it, reviews post as the PR author.

Repos can be listed with SSH URLs. The factory rewrites them to HTTPS and uses the token for its own clone and push only, so the container needs no SSH keys.

Code is on GitHub today. Each code host is a vendor in `orchestrator/src/hosts/`, and adding GitLab, Bitbucket or another host needs no changes to the stages: see [docs/adding-a-code-host.md](docs/adding-a-code-host.md).

### 3. Claude
Use either:
- `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, which uses your subscription; or
- `ANTHROPIC_API_KEY`.

### 4. Register repos
In `factory.config.yml` (see the [full reference](#factoryconfigyml-factory-wide)):
```yaml
repos:
  - name: portfolio          # kebab-case, unique
    git: git@github.com:SreekeshOkky/portfolio.git
    base_branch: main
    tracker: { type: jira, project: KAN }   # add `component: web` to route one project to several repos
    # host: { type: github }               # optional: inferred from github.com URLs
```
No code changes are needed to add a repo. The older `jira: { project: KAN }` form still works.

### 5. Onboard each repo
Run the `onboard-repo` skill on the repo, either in Claude Code on your machine or in the container. Load it from `plugins/factory/` as a plugin, or copy `plugins/factory/skills/onboard-repo/` into `~/.claude/skills/`. Then run:
```
/onboard-repo [path-to-repo] [--base <branch>] [--no-pr]
```
It does the following:
1. Surveys the repo's conventions: stack, layout, code and commit style, styling, a11y/SEO, tests, sync points, and dangerous files.
2. Writes `CLAUDE.md` (merging into an existing one), `factory.yml` and `docs/app-navigation.md`.
3. Adds a test harness if the repo has none, with a passing seed test per layer, and proves it can go red. Recipes exist for Astro, Next.js, Vite + React and Python.
4. Self-checks every `factory.yml` command.
5. Opens an onboarding PR from `factory/onboard`, after asking you. `--no-pr` stops before pushing.

It works in a separate git worktree if your checkout has uncommitted changes.

**Review that PR carefully.** Its `factory.yml` commands run in the container, and its `CLAUDE.md` is the rulebook for every ticket.

### 6. Run
```bash
cp .env.example .env   # fill it in
```
```bash
DRY_RUN=true docker compose run --rm factory node /app/orchestrator/dist/index.js --once
```
Dry run skips every tracker and code-host write and the push, and logs what it would do. **It still runs the agents, so it costs tokens**, and because no labels change, a long-running dry run rebuilds the same ticket every poll. Use it with `--once`.

```bash
docker compose up -d --build && docker compose logs -f
```

Run one tick and exit (useful for debugging):
```bash
docker compose run --rm factory node /app/orchestrator/dist/index.js --once
```

On `SIGTERM` (`docker compose stop`), the factory finishes the current stage, then exits.

## Configuration

### `factory.config.yml` (factory-wide)

Mounted read-only into the container, so edits need only a restart.

| Key | Default | Meaning |
| --- | --- | --- |
| `poll_interval_seconds` | `60` | Time between ticks |
| `statuses.todo` / `in_progress` / `review` / `done` | (required, `review` optional) | Exact status names in your Jira workflow |
| `enable_label` | `factory-enabled` | Only tickets with this label are touched |
| `max_turns.build` / `evidence` / `review` / `verify` | `150` / `40` / `40` / `60` | Turn budget per agent run |
| `models.build` / `review` / `verify` | `opus` / `opus` / `sonnet` | `claude --model` alias per role. The evidence agent uses `verify`; regression tests use `build`. |
| `regression_tests` | `false` | Open a Playwright regression-test PR after a fully passing verification |
| `repos[]` | (at least one) | `name`, `git`, `base_branch` (default `main`), `tracker` and `host` |
| `repos[].host` | inferred for `github.com` | `type` (the code host: `github`) plus that host's options. Required when the git URL isn't on a known hostname. |
| `repos[].tracker` | (required) | `type` (the vendor: `jira`) plus that vendor's options. For Jira: `project`, and optional `component`. |

For Jira, tickets route to a repo by project, then component: a repo with a matching `component` wins over one without.

Tickets come from Jira today. Every tracker vendor lives in `orchestrator/src/trackers/`, and adding one (GitHub Issues, GitLab, Linear, Asana, ...) needs no changes to the stages: see [docs/adding-a-tracker.md](docs/adding-a-tracker.md).

### `factory.yml` (per repo)

The only thing the factory knows about a repo. `onboard-repo` writes it from [the template](plugins/factory/skills/onboard-repo/templates/factory.yml.tmpl).

| Key | Meaning |
| --- | --- |
| `install` | Install dependencies in a fresh clone. If the repo has its own Playwright, the factory also installs its Chromium. |
| `check` | Optional static/type check. It runs before `test` in the red-green check. |
| `test` | The one command that decides red/green. It must not need secrets or network. |
| `start` | Build and serve the production app on `port`, in the foreground. |
| `port`, `ready_path` | Where the app listens, and the path polled until it answers (default `/`) |
| `navigation_doc` | Notes for the verifier (default `docs/app-navigation.md`) |
| `protected_paths` | Globs the builder must not change. `.env*` and `factory.yml` are always added. |
| `commit_style` | `prefixes` the builder uses, and a `trailer` (default `Jira: {KEY}`) |
| `ticket_modes` | Red-test recipes. The first non-default mode whose `match.labels` or `match.issue_types` hits the ticket wins; otherwise `default`, which is required. |

### Environment (`.env`)

| Variable | Required | Meaning |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | one of them | Claude auth |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | if a repo uses Jira | Jira Cloud site and factory account |
| `JIRA_ROVO_MCP`, `JIRA_ROVO_MCP_URL` | no | Give the builder Rovo MCP (default off) |
| `GH_TOKEN` | if a repo is on GitHub | Clone, push and open PRs |
| `GH_REVIEWER_TOKEN` | no | Post reviews from a second account (falls back to `GH_TOKEN`) |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | no | Identity on factory commits |
| `DRY_RUN` | no | `true` skips tracker and code-host writes (see [Run](#6-run)) |

The container refuses to start without the required ones. Each tracker's and code host's variables are checked only if a repo uses it. Build args `CLAUDE_CODE_VERSION` and `PLAYWRIGHT_MCP_VERSION` pin the CLI versions (default `latest`).

## Watching progress

| Question | Where to look |
| --- | --- |
| Which stage is every ticket at? | `docker compose exec factory status` lists each ticket with its state (RUNNING, BLOCKED or idle), stage and current step, when it last changed, its total cost and its PR. |
| What happened to one ticket? | `docker compose exec factory status KAN-4` shows the full timeline, the red/green commits, the cost and the last error. |
| What's happening right now? | `docker compose logs -f`. Every step (`KAN-4 [build] installing dependencies`) and every agent tool call (`KAN-4-build › Edit src/…`, `› Bash npm test`) appears as it happens, plus each agent's time, turns and cost when it ends. |
| Log after a container restart | `/data/factory.log` holds the same lines. Docker's own log is rotated at 5 × 20 MB. |
| Exactly what an agent did | `/data/runs/KAN-4-build-<time>.jsonl` holds every message, tool call and tool result, streamed live. Claude Code's own session files persist in the `agent-transcripts` volume. |
| The workspace of a failed stage | `/work/<repo>/KAN-4-<stage>`. Clones are deleted when a stage succeeds and kept when it fails. |
| From Jira | Labels show the stage. Comments mark the build start, PR, review, merge, verdict and any block. |

```bash
docker compose exec factory tail -f /data/factory.log
docker compose exec factory sh -c 'ls -t /data/runs/*.jsonl | head'
```

Volumes: `factory-data` (`/data`: state, logs, transcripts), `factory-work` (`/work`: clones), `agent-transcripts`, and `browsers` (Chromium builds for each repo's Playwright).

## Development
```bash
cd orchestrator && npm install && npm test && npm run typecheck
```
`npm run dev` runs the orchestrator from source with `tsx`. Outside the container, `AGENT_USER` is unset, so agent commands run as you, and `FACTORY_CONFIG`, `DATA_DIR` and `WORK_DIR` override the container paths.

Turn on the repo's git hooks once per clone:
```bash
git config core.hooksPath .githooks
```
The `pre-push` hook refuses any push to `main`, so changes land through a PR. It runs only on your machine and `git push --no-verify` skips it. GitHub doesn't protect `main` because branch protection on a private repo needs GitHub Pro.

Layout:
- `orchestrator/src/index.ts`: the poll loop
- `stages/*`: one file per lifecycle step (`build`, `review`, `close`, `verify`), plus the shared `context.ts` and blocking logic
- `redgreen.ts`: the TDD check
- `repo.ts`: the `factory.yml` contract, ticket modes and protected paths
- `config.ts`: `factory.config.yml` and environment. `labels.ts`: the progress labels
- `trackers/`: ticket-tracker vendors behind one `Tracker` interface (`types.ts`), registered in `index.ts`. `trackers/jira/` is the Jira Cloud client.
- `hosts/`: code-host vendors behind one `CodeHost` interface (`types.ts`), registered in `index.ts`, with shared `diff.ts` and `git.ts` helpers. `hosts/github/` is the GitHub client.
- `claude.ts`: the agent runner
- `prompts.ts`: what each agent is told
- `workspace.ts`, `exec.ts`: clones, pushes, the app process and the `agent` user boundary
- `state.ts`, `status.ts`, `log.ts`: progress tracking and the `status` command
- `orchestrator/test/`: unit tests (vitest)
- `docker/claude-home/`: the agents, the `red-green` skill and the deny rules, installed as the `agent` user's `~/.claude`
- `docker/agent-exec`, `docker/sudoers-factory`, `docker/entrypoint.sh`: the user separation and container setup
- `plugins/factory/`: the `onboard-repo` skill with its templates and stack references

## Known limits
- **One ticket at a time.** The dev server port and the preview data are shared.
- **Reviews run once per PR.** New pushes after the review don't trigger another one.
- **The verifier runs after merge, against the base branch,** as requested. The article argues for verifying a preview *before* merge. Moving the verify stage before the human gate is a small change in `index.ts`.
- **Screenshots are committed to the PR branch** under `.factory/evidence/KEY/`. GitHub has no API for uploading images, so this is how the PR shows them. Each code host decides the image link (`CodeHost.fileUrl`).
- **Timeouts:** 90 minutes per agent run, 20 for `install`, 30 for `test`, and 5 for the app to become ready.
- **A failed regression-test PR** is only logged. It doesn't block the ticket.
