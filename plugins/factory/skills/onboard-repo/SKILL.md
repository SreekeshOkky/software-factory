---
name: onboard-repo
description: Onboard a target repo onto the Jira-driven software factory. Surveys the repo, then writes the contract files the factory reads (CLAUDE.md, factory.yml, docs/app-navigation.md), adds a test harness with seed tests, self-checks the commands, and opens an onboarding PR on branch factory/onboard. Use when asked to "onboard a repo", "make this repo factory-ready", or run /onboard-repo.
argument-hint: "[path-to-repo] [--base <branch>] [--no-pr]"
---

# onboard-repo

The factory knows nothing about a repo except what these files say:

| File | Read by | Purpose |
|---|---|---|
| `CLAUDE.md` | every agent | Project rules: stack, conventions, styling, a11y/SEO, sync points, commits, off-limits files |
| `factory.yml` | orchestrator + builder | Commands, port, ticket modes, protected paths, commit style |
| `docs/app-navigation.md` | verifier | How to reach every screen in the running app |
| test harness | `factory.yml` `test` | Must be able to **fail** (red) and **pass** (green) |

Your job is to produce these files from what the repo **actually does**, not
from generic best practice, and land them as a PR a human reviews.

Resources next to this file (resolve paths relative to this SKILL.md's directory;
it works both as the `factory` plugin and copied standalone into
`~/.claude/skills/onboard-repo/`):
- `templates/CLAUDE.md.tmpl`, `templates/factory.yml.tmpl`, `templates/app-navigation.md.tmpl`
- `references/<stack>.md`: stack-specific harness recipes (`astro`, `next`,
  `vite-react`, `python`). Read the one that matches. If none matches, use the
  closest one and adapt; say so in the PR.

## Arguments
- Repo path: defaults to the current directory.
- `--base <branch>`: the branch to start from and target with the PR.
  Defaults to the remote's default branch (`git symbolic-ref refs/remotes/origin/HEAD`).
  If that branch is clearly stale (the checked-out branch is far ahead of it
  and is where recent work lands), **stop and ask** which base to use.
- `--no-pr`: stop after the branch is ready; don't push.

## Ground rules
- **Never push to the base branch.** All work goes on `factory/onboard`.
- **Don't disturb the user's working tree.** If it has uncommitted or untracked
  changes, don't stash or reset them. Create a separate worktree instead:
  `git worktree add -b factory/onboard ../<repo>-onboard <base>`, and work there.
  Never commit files that weren't yours (untracked drafts, local config).
- Don't change application behaviour. Onboarding adds docs, config, tests and
  test scripts. The only source edits allowed are ones the harness strictly needs
  (for example a test-only export). List every one in the PR body.
- Don't add a linter or formatter the repo doesn't have unless the user asks.
  Record the observed style in CLAUDE.md instead.
- Don't commit secrets. Seed tests must not need `.env` values or network access.
- Ask before pushing or opening the PR, unless the user already said to.

## Step 1. Survey

Read before you write. Collect evidence (file paths, short snippets) for each item;
you'll cite them in CLAUDE.md and the PR body.

1. **Stack and scripts.** `package.json` / `pyproject.toml` / lockfiles, framework
   config (`astro.config.*`, `next.config.*`, `vite.config.*`), runtime version
   (`.nvmrc`, `engines`), the package manager (from the lockfile), adapters,
   output mode, dev server port.
2. **Layout.** `ls` the top level and `src/` (or equivalent). Routes/pages,
   components, layouts, lib, data, content collections and their schemas,
   API/serverless routes, scripts.
3. **Code conventions.** Look at 3–5 representative files of each kind. Record:
   TypeScript strictness (`tsconfig`), module style, import style (relative vs
   aliases), quotes, indentation (tabs vs spaces; check with
   `grep -c $'^\t' file`), naming (file and symbol case), props/typing patterns,
   comment style (header comments? JSDoc?), client-side script patterns. Note where
   files disagree. Record the **majority** style and name the exceptions.
4. **Styling.** CSS approach (plain, modules, Tailwind, CSS-in-JS), where tokens
   live, theming/dark mode mechanism, breakpoints actually used
   (`grep -rhoE "@media[^{]+" src | sort | uniq -c | sort -rn`),
   reduced-motion handling.
5. **a11y and SEO patterns.** The head/SEO component and its required props,
   heading rules, image component and alt usage, `aria-*` patterns, canonical
   URLs / trailing slash rules, sitemap, structured data, llms.txt or similar.
6. **Tests.** Any existing runner, config, test dirs, CI workflows
   (`.github/workflows`). Existing tests are kept and must pass.
7. **Lint and agent config.** ESLint/Prettier/Biome/Ruff configs, `.editorconfig`,
   existing `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.claude/`, `.agents/`, and
   skills. Note anything **gitignored** that agents are told to rely on: a fresh
   clone won't have it.
8. **Commit style.** `git log --format=%s -200 | sed -E 's/^([a-zA-Z]+)(\(.*\))?!?:.*/\1/' | sort | uniq -c | sort -rn`.
   Record the prefixes, casing, scope usage and tone.
9. **Sync points.** Things that must change together: constants duplicated across
   config files, lists that mirror routes, generated assets with a regenerate
   command, "keep in sync with" comments (`grep -rn -i "keep in sync\|must match" .`).
10. **Dangerous or human-only things.** Deploy scripts, secret/key files, security
    headers/CSP, scripts that call external services (search-engine pings,
    publishing). These become `protected_paths` and CLAUDE.md "off limits" rules.
11. **Does it build?** Run install and build once now. Note anything the factory
    container will need (env vars with safe defaults, system deps) and whether the
    framework's own `preview` works with the configured adapter.

## Step 2. Write `CLAUDE.md`

Fill `templates/CLAUDE.md.tmpl` from the survey. Rules:
- Every rule must be something the repo already does, with a pointer to an
  example file. Don't invent rules.
- Short imperative bullets. Agents read this on every ticket.
- Keep the "Factory" section: it tells agents about the harness, ticket modes,
  commit trailer and protected paths.
- **If `CLAUDE.md` exists, merge, don't overwrite.** Keep every existing line and
  its order. Add missing sections from the template under clearly named headings.
  If an existing rule contradicts the survey, keep it and flag the conflict in the
  PR body rather than editing it silently. If `AGENTS.md` exists and `CLAUDE.md`
  doesn't, create `CLAUDE.md` that starts with `@AGENTS.md` and holds only what
  AGENTS.md lacks.

## Step 3. Test harness

Read `references/<stack>.md` and follow it. In general:
- **Reuse** an existing runner if there is one. Otherwise add the reference's.
- Layers: a **unit/component** layer (fast, no browser) and an **e2e** layer
  (Playwright against the built app) for web apps; pytest (plus an HTTP or
  Playwright layer if there's a UI) for Python.
- Add a type/static check script if the stack has one (`astro check`, `tsc --noEmit`,
  `mypy`), and **make it pass on the current code first**. If it reports existing
  errors you can't fix without behaviour changes, leave `factory.yml` `check`
  empty and say so in the PR.
- Write **one small passing seed test per layer**. It should exercise real code
  (render a real component, call a real lib function, load a real page), so the
  builder has a pattern to copy.
- Scripts: `test` (unit), `test:e2e`, `check`. The e2e config starts the app
  itself (Playwright `webServer`) on a port that doesn't clash with `factory.yml`
  `port`, so it can run while the factory has the app up.
- Gitignore test output (`test-results/`, `playwright-report/`, `coverage/`).
- Prove the harness can go red: temporarily break a seed assertion, confirm
  the `test` command exits non-zero, then revert. Don't commit the broken version.

## Step 4. `factory.yml` and `docs/app-navigation.md`

`factory.yml`: copy `templates/factory.yml.tmpl` and fill every key. The key set
is a contract with the orchestrator. **Don't rename, drop or add top-level keys.**
- The factory decides red/green with `check && test`. Set `check` only if it
  passes today; otherwise leave it `""` and say so in the PR. Don't repeat
  `check` inside `test`.
- `start` must build and serve the production build on `port` and keep running.
  Prefer the framework's preview. If the adapter doesn't support it, add a tiny
  zero-dependency static server script (see the reference file).
- `ticket_modes.default` is required. Add a mode for each distinct kind of work the
  repo gets (content, docs, data, migrations…) whose red tests look different.
  Each `recipe` says **what the failing tests must assert**, concretely, using
  this repo's routes, schemas and test helpers.
- `protected_paths`: from survey item 10, plus `.env*`.
- `commit_style.prefixes`: from survey item 8, most used first.

`docs/app-navigation.md`: fill `templates/app-navigation.md.tmpl` for the
verifier, who reads **no source code**. Start the app (`start`) and crawl:
list every route from the router/pages dir and the sitemap, `curl` each, and
note the persistent UI (header, mobile nav, menus, palettes, theme toggle, modals)
with how to open it (selector, keyboard shortcut) and what it contains. Describe
dynamic routes with one real example URL each. Note anything that needs secrets or
network and won't work locally.

## Step 5. Self-check

Run each command from `factory.yml` in a clean state, exactly as written:
1. `install`: must exit 0.
2. `check` (if set) and `test`: must exit 0.
3. `start` in the background. Poll `http://localhost:<port><ready_path>` until it
   returns **200** (timeout 120s), then stop the server. If the port is busy
   locally (a dev server is running), say so and run the check with the same
   command on a free port. Don't kill the user's processes.
4. Validate `factory.yml`: parse it as YAML and check it has every key from the
   template, `port` is a number, and `ticket_modes.default.recipe` is non-empty.

If anything fails, fix the harness or the commands and rerun all of it. Report
the outputs (exit codes, test counts, the HTTP status) in the PR body.

## Step 6. Branch and PR

- Commit on `factory/onboard` in small commits using the repo's own prefix style
  (for example `docs: add CLAUDE.md for agents`, `test: add vitest and playwright
  harness with seed tests`, `chore: add factory.yml`).
- Show the user the commit list and diffstat. **Ask before pushing.**
- Push `factory/onboard` (never the base) and open the PR with
  `gh pr create --base <base> --head factory/onboard`. The PR body has:
  summary; what the survey found (stack, conventions, gaps); every file added or
  changed; any source edits and why; self-check results; open questions and
  conflicts (gitignored agent resources, existing rules that disagree, checks
  left out of `test`).
- If `gh` isn't available or the user declines, leave the branch ready and print
  the exact push and PR commands.
