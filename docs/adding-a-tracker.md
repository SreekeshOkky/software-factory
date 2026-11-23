# Adding a ticket tracker

The factory reads work from a **tracker**: Jira today, and GitHub Issues, GitLab, Linear, Asana or anything else with an API next. Every vendor sits behind one interface, so adding one means writing **one folder and one registry line**. The stages, prompts and poll loop don't change.

```
orchestrator/src/trackers/
├── types.ts          the contract: Issue, Queue, Tracker, TrackerVendor
├── index.ts          the registry (VENDORS) and how the factory picks a tracker per repo
└── jira/
    ├── index.ts      the Jira Cloud client and its TrackerVendor export
    └── markup.ts     Markdown -> Jira wiki markup
```

A repo picks its tracker in `factory.config.yml`:

```yaml
repos:
  - name: portfolio
    git: git@github.com:you/portfolio.git
    tracker:
      type: jira        # the vendor id
      project: KAN      # everything else is that vendor's own options
```

Different repos can use different trackers. The factory builds one instance of each tracker type that's in use.

## Steps

1. **Create `orchestrator/src/trackers/<id>/index.ts`.** `<id>` is kebab-case, e.g. `github-issues`, `gitlab`, `linear` or `asana`.
2. **Write a class that implements `Tracker`** (see [the contract](#the-contract)).
3. **Export a `TrackerVendor`** with:
   - `id`, the same as the folder name;
   - `name`, used in errors;
   - `repoConfig`, a zod schema for the repo's `tracker:` block;
   - `create(init)`, which reads credentials with `init.requireEnv(...)` and returns your tracker.
4. **Register it** in `orchestrator/src/trackers/index.ts`:
   ```ts
   import { linear } from "./linear/index.js";
   export const VENDORS = { [jira.id]: jira, [linear.id]: linear };
   ```
5. **Add tests** in `orchestrator/test/tracker-<id>.test.ts`. Use [`tracker-jira.test.ts`](../orchestrator/test/tracker-jira.test.ts) as the template, and see the [checklist](#tests).
6. **Document it:**
   - add its environment variables to `.env.example` and the README's Environment table;
   - add its `tracker:` options to the README's `repos[].tracker` row;
   - add a short setup section for its account and permissions.

The registry test in [`trackers.test.ts`](../orchestrator/test/trackers.test.ts) checks that every registered vendor's key matches its `id`.

## The contract

All of it is in [`types.ts`](../orchestrator/src/trackers/types.ts). Workflow decisions stay in plain code: the stages call these methods and agents never do.

| Method | What it must do |
| --- | --- |
| `find(queue, repo)` | Return the ticket keys in one queue for this repo, in the order to work them (the [queues table](#the-four-queues) gives the rules). |
| `getIssue(key)` | Return an `Issue`. Fill `descriptionFormat` (e.g. `"Markdown"`) so agents know what they're reading. Use `""` / `[]` for fields the tracker doesn't have. |
| `route(repos, issue)` | Pick which of `repos` (already filtered to your type) owns the ticket, or `undefined`. A ticket found for one repo but routed to another is skipped. |
| `transitionTo(key, status)` | Move the ticket to the status named in `factory.config.yml` → `statuses`. Return `false`, without throwing, if it can't. The close stage blocks the ticket on `false`. |
| `updateLabels(key, add, remove)` | Add or remove the `factory-*` progress labels. |
| `comment(key, markdown)` | Post a comment. The input is GitHub-flavoured Markdown (headings, bold, code, links, tables), so convert it if the tracker uses another format. |
| `attach(key, files)` | Attach PNG screenshots to the ticket. |
| `describe(repo)` | Return a short label for the startup log, e.g. `linear:WEB`. |
| `agentMcpServers()` | Optional. Return the MCP servers to give the builder, e.g. Jira's Rovo. Their tools are allowed as `mcp__<name>__*`. |

### The four queues

Each poll goes through the queues in this order for each repo. Every query is limited to the repo's scope and the `enable_label`, and skips anything labelled `factory-blocked`.

| Queue | Matches | Order |
| --- | --- | --- |
| `toClose` | Labelled `factory-pr-open`, not `factory-merged`, and status not `done` | any |
| `toVerify` | Status `done`, not `factory-verified` and not `factory-verify-failed` | oldest resolved first |
| `toReview` | Labelled `factory-pr-open`, not `factory-reviewed` and not `factory-merged` | least recently updated first |
| `toBuild` | Status `todo`, not `factory-building` and not `factory-pr-open` | highest priority, then oldest |

If the tracker can't filter on the server, fetch the candidates and filter them in code. Getting these queries wrong is the main way a tracker breaks the factory: a ticket that keeps matching `toBuild` gets rebuilt every poll and burns tokens.

## Mapping concepts that don't line up

| Factory idea | Jira | Ideas for other trackers |
| --- | --- | --- |
| **Status** (`todo` / `in_progress` / `review` / `done`) | Workflow transitions | **GitHub:** open/closed plus a `status:*` label, or a Projects v2 field. **GitLab:** scoped labels (`status::todo`) or open/closed. **Linear:** workflow states. **Asana:** sections or a custom field. |
| **Labels** | Labels | **GitHub, GitLab, Linear:** labels. **Asana:** tags. Create any that are missing the first time you use them. |
| **Ticket key** | `KAN-12` | It must be **path-safe** (it goes into the branch `factory/<key>` and into folder names), and `getIssue(key)` must accept it back. For trackers with only numbers, add a prefix such as `GH-42`. |
| **Routing scope** | Project, then component | **GitHub:** owner/repo. **GitLab:** project id. **Linear:** team, then project. **Asana:** project, then section. |
| **Priority** for `toBuild` | Priority field | Use a priority field if there is one, or labels like `priority:high`. Otherwise order by oldest first. |
| **Attachments** | Attachments API | **GitLab, Linear, Asana:** have upload APIs. **GitHub Issues** has none, so link the screenshots the build stage already commits under `.factory/evidence/<KEY>/`, or skip them. |
| **Markup** | Wiki markup (`markup.ts`) | **GitHub, GitLab, Linear:** Markdown, no conversion needed. **Asana:** its own rich-text HTML. |

## Rules every tracker follows

- **Dry run:** when `init.dryRun` is true, log every write (transition, labels, comment, attachment) and skip it. Reads still happen. See `Jira.mutating()`.
- **Retries:** retry network errors, 429 and 5xx with backoff, and fail fast on other 4xx errors. The poll loop runs for days, so a laptop waking up shouldn't block tickets. See `Jira.fetchRetry()`.
- **Credentials stay with the orchestrator.** Read them in `create()` from `init.requireEnv`. They live in the `factory` user's environment, and the agent user never sees them. The one exception is `agentMcpServers()`: anything you return there is written to a file the agent can read for the length of its run. Say so in your docs, and keep it off by default.
- **Ticket text is untrusted.** Return it as it is. The prompts already wrap it as data. Don't run anything from it.
- **No vendor-specific code outside your folder.** If you need something new from the stages, add it to the `Tracker` interface as an optional method, and make it work for Jira too.

## Tests

Use a fake `fetchImpl` (or your SDK's equivalent), as `tracker-jira.test.ts` does. At minimum, cover:

- [ ] Each `find` queue includes the repo scope and the `enable_label`, and excludes `factory-blocked` and the queue's done labels.
- [ ] `toBuild` never returns a ticket that is `factory-building` or `factory-pr-open`.
- [ ] `transitionTo` returns `false` when the status can't be reached.
- [ ] Dry run makes no write calls.
- [ ] Retries: a network error, then a 5xx, then success. It gives up with a short message, and doesn't retry 4xx.
- [ ] `route` picks the right repo and returns `undefined` for an unknown scope.
- [ ] Your `repoConfig` rejects a missing required option.
- [ ] Markup conversion, if any.

Then run:

```bash
cd orchestrator && npm test && npm run typecheck
```

Finally, run one real tick against a test project:

```bash
DRY_RUN=true docker compose run --rm factory node /app/orchestrator/dist/index.js --once
```

## Scope

This covers where tickets come from. Where code lives (clone, push, PRs and reviews) is a separate vendor type: see [adding-a-code-host.md](adding-a-code-host.md). Any tracker works with any code host.
