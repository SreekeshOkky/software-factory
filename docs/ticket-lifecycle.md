# How a Jira ticket moves through the factory

This page follows one ticket from **To Do** to a verified feature. It covers every way the ticket can stop, and what you do to get it moving again. The [README](../README.md#how-a-ticket-flows) has the short version.

```
             ┌──────────── factory-blocked (any stage) ◀────────────┐
             │                                                       │
 To Do ──▶ BUILD ──▶ PR open ──▶ REVIEW ──▶ human merges ──▶ CLOSE ──▶ Done ──▶ VERIFY
 (you)     In Progress           comments    (you)          ticket → Done        │
                                                                                 ├─▶ factory-verified (+ optional regression-test PR)
                                                                                 └─▶ factory-verify-failed  (you decide)
```

## 1. What the factory reads from a ticket

The factory picks up a ticket only if all of these are true:

- It is in a project listed under `repos` in `factory.config.yml`. If that repo entry sets a `component`, the ticket must have that component too.
- It has the **`factory-enabled`** label.
- It is in the status the stage looks for (see [the stages](#2-the-stages)).

From the ticket, the agents get **only the summary and the description**. Nothing else is fetched: not the comments, attachments, linked issues or history ([trackers/jira](../orchestrator/src/trackers/jira/index.ts), [prompts.ts](../orchestrator/src/prompts.ts)). The builder, reviewer, evidence agent and verifier all see the same text.

This has consequences:

- **The description is the specification.** If the developer and the stakeholder agreed changes in comments before the ticket went to To Do, write the outcome into the description. The builder builds from the description, the reviewer reviews against it, and the verifier passes or fails the app against it. If a change was only agreed in a comment, the verifier may FAIL behaviour that is actually right.
- **Answers in comments are ignored.** If the factory blocks a ticket and you reply in a comment, the next run won't see your reply. Edit the description.
- **Every run starts fresh.** A retry doesn't carry over the previous attempt's reason, review or verdicts.
- With `JIRA_ROVO_MCP=true` the builder *can* look up comments and linked issues itself, but nothing tells it to. Don't rely on it. The reviewer and verifier never have it.

Write acceptance criteria as numbered, checkable outcomes. The builder writes at least one test per criterion. The verifier gives each criterion PASS, FAIL or UNTESTABLE. If a ticket has no criteria, the builder derives them from the description and says so. The verifier, though, may then extract different ones, so explicit criteria are much safer.

## 2. The stages

Every poll (60 s by default), for each repo, the factory runs: **close → verify → review → build (at most one ticket)**. Stages run one at a time.

### Build: To Do → In Progress → PR open

Picks the highest-priority To Do ticket (oldest first) that doesn't have `factory-building`, `factory-pr-open` or `factory-blocked`.

1. Adds `factory-building`, moves the ticket to **In Progress** and comments "Factory started building".
2. Clones the base branch. If the repo has no `factory.yml`, the ticket is blocked as not onboarded.
3. Creates branch `factory/KEY`, installs dependencies and picks a **mode** from `factory.yml` by label or issue type (for example `content` for a blog post).
4. The **builder** works red-green: it commits failing tests (`Factory-Phase: red`), then the implementation. If the ticket is too vague to test, or blocked by something outside the repo, it stops with `STATUS: BLOCKED` and a reason. That is a valid outcome, not an error.
5. **The factory checks the result itself:**
   - there is at least one commit;
   - no protected path changed (`.env*`, `factory.yml` and the repo's `protected_paths`);
   - there is exactly one red commit, with at least one commit after it;
   - the tests **fail** at the red commit and **pass** at HEAD.

   If tests from the red commit were edited later, the ticket isn't blocked. The PR and the Jira comment are flagged so a human can check that no assertion was weakened.
6. Starts the app. The **evidence agent** screenshots each criterion, and the screenshots are committed under `.factory/evidence/KEY/`.
7. Pushes the branch and opens the PR. It attaches the screenshots to Jira and comments with the PR link. Then it moves the ticket to **In Review** (if `statuses.review` is set), and swaps `factory-building` for `factory-pr-open`.

### Review: PR open → reviewed

Picks tickets with `factory-pr-open` that don't have `factory-reviewed`, `factory-merged` or `factory-blocked`, and whose PR is open.

- The **pr-reviewer** reads the ticket, the diff and `CLAUDE.md`. It checks criterion coverage, CLAUDE.md rules, correctness, security and scope.
- The factory posts its output as a `COMMENT` review on GitHub. Comments on lines outside the diff go into the review body. It also adds a Jira comment with the counts, and the label `factory-reviewed`.
- The reviewer **never approves or blocks**, and **the factory never acts on the review comments**. Nothing pushes fixes for them. A human decides ([section 4](#4-resolving-review-and-verifier-comments)).
- It reviews **once per PR**. Later pushes aren't reviewed again unless you remove `factory-reviewed`.

### Close: merge → Done

Picks tickets with `factory-pr-open` that don't have `factory-merged` or `factory-blocked`, and aren't in Done yet.

- **PR merged by a human:** moves the ticket to **Done**, comments, and adds `factory-merged`.
- **PR closed without merging:** blocks the ticket.
- **PR still open:** does nothing. It checks again on every poll.

### Verify: Done → verified / verify-failed

Picks tickets in **Done** that don't have `factory-verified`, `factory-verify-failed` or `factory-blocked`. This includes tickets you moved to Done by hand.

- Clones the **base branch** (after the merge), installs dependencies and starts the app.
- The **ticket-verifier** gets only the ticket, the app's URL and `docs/app-navigation.md`. It sees no code, diff, PR or builder summary. It gives each criterion one verdict:
  - **PASS**: it saw the behaviour. Thin evidence counts as UNTESTABLE.
  - **FAIL**: it saw something else. A screenshot is attached.
  - **UNTESTABLE**: the criterion is too vague, or it couldn't reach the state the criterion needs. A login page also stops it, because it never logs in.
- The factory posts a verdict table and the screenshots to Jira.
  - **Every criterion PASS:** adds `factory-verified`. If `regression_tests: true`, the builder also writes Playwright regression tests on `factory/KEY-regression`, and the factory opens a PR once the suite passes. If that step fails, it only logs a warning. The ticket stays verified.
  - **Anything else:** adds `factory-verify-failed`. This is **not** a block. The ticket stays in Done, and a human decides what to do next ([section 4](#4-resolving-review-and-verifier-comments)).

## 3. Labels

| Label | Added when | Removed by |
| --- | --- | --- |
| `factory-enabled` | You, to opt the ticket in | You |
| `factory-building` | Build starts | Build success, or a build block |
| `factory-pr-open` | PR opened | Never by the factory. You remove it to rebuild. |
| `factory-reviewed` | Review posted | Never by the factory. You remove it to get another review, or to rebuild. |
| `factory-merged` | PR merged and ticket moved to Done | Never by the factory. You remove it to rebuild. |
| `factory-verified` | All criteria PASS | Never by the factory |
| `factory-verify-failed` | Any criterion FAIL or UNTESTABLE | You, to verify again or to rebuild |
| `factory-blocked` | Any stage failed (with a "Factory stopped (stage)" comment) | You, to retry |

## 4. Resolving review and verifier comments

The factory **doesn't fix anything after the PR is open**. Review comments and verifier verdicts are for a person to act on.

### Review comments on the PR (before merge)

| You want to | Do this |
| --- | --- |
| Fix the comments yourself | Check out `factory/KEY`, push the fixes (by hand or with your own Claude Code session) and merge. |
| Get a fresh review after your fixes | Remove `factory-reviewed`. The review runs again on the next poll. |
| Disagree with a comment | Ignore it and merge. The review is advisory. |
| Throw the attempt away | Close the PR, which blocks the ticket. Fix the description, then [rebuild an open-PR ticket](#5-how-to-retrigger). |

### Verifier verdicts in Jira (after merge)

The code is already on the base branch, so there's no PR left to fix.

| Verdict | Usually means | Do this |
| --- | --- | --- |
| FAIL, behaviour really wrong | A bug the tests didn't catch | Fix it in a new ticket or PR, or [rebuild the ticket](#5-how-to-retrigger). The builder starts from the base branch, which already has the merged change. |
| FAIL, but the app is right | The description is outdated (for example, changes agreed only in comments) | Update the description, then remove `factory-verify-failed` to verify again. |
| UNTESTABLE, wording | The criterion is too vague to check | Reword it in the description, then remove `factory-verify-failed`. |
| UNTESTABLE, couldn't reach the state | Missing navigation notes, seed data, or a login wall | Fix `docs/app-navigation.md` or the seed data in the target repo, then remove `factory-verify-failed`. |
| FAIL or UNTESTABLE, environment problem | The app was slow, or a page was flaky | Remove `factory-verify-failed` to try again. |

## 5. How to retrigger

**First read the "Factory stopped" comment.** Fix what it names, then change the labels and status as below. Fixes to *what to build* go in the description. Fixes to the setup go outside Jira.

### Why it was blocked, and where to fix it

| Stage | Reason in the comment | Fix |
| --- | --- | --- |
| build | "The builder stopped": criteria too vague or unclear | **Description**: add or clarify the acceptance criteria |
| build | "The builder stopped": blocked by something outside the repo (an API, a decision, another ticket) | Resolve the dependency. Update the description only if the scope changed. |
| build | No `factory.yml` on the base branch | Run `onboard-repo` on the repo. The ticket is fine. |
| build | Change touches protected paths | A human makes that change, or you split the ticket (edit the description) |
| build | Red-green check failed (no red commit, more than one, tests pass at red, tests fail at HEAD) | Often a one-off, so retry. If it keeps happening, the ticket is probably too big or unclear: tighten or split it. |
| build | Builder made no commits, or the run didn't finish (turn budget) | Retry. If it repeats, split the ticket or raise `max_turns.build`. |
| review | Reviewer output couldn't be parsed | Retry |
| review | `factory-pr-open` set but no PR exists | Remove `factory-pr-open` and rebuild, or open the PR |
| close | PR closed without merging | Reopen the PR, or rebuild |
| close | Merged, but the workflow has no transition to Done | Fix the Jira workflow, or move the ticket to Done by hand |
| verify | Repo not onboarded, the app didn't start, or the verifier returned no verdicts | Fix the environment or the repo, then retry |
| any | "Unexpected error" | Check the factory logs, fix the cause, then retry |

### What to change on the ticket

| Situation | Status | Labels |
| --- | --- | --- |
| **Blocked in build** | Move from In Progress back to **To Do** | Remove `factory-blocked` |
| **Blocked in review, close or verify** | Leave it as it is | Remove `factory-blocked` |
| **Another review** of an open PR | Leave it | Remove `factory-reviewed` |
| **Verify again** without rebuilding | Leave it in **Done** | Remove `factory-verify-failed` |
| **Rebuild a ticket whose PR is open or closed** | Move to **To Do** | Close the PR if it's still open. Remove `factory-blocked`, `factory-pr-open` and `factory-reviewed`. |
| **Rebuild a ticket that was already merged** | Move from Done to **To Do** | Remove `factory-pr-open`, `factory-reviewed`, `factory-merged` and `factory-verify-failed` (or `factory-verified`) |

Notes:

- A rebuild force-pushes `factory/KEY` and opens a **new** PR. Old closed or merged PRs are left alone.
- If you leave `factory-merged` on a rebuilt ticket, the new PR's merge is never picked up. If you leave `factory-pr-open`, the ticket never enters the build queue.
- A blocked ticket is skipped by every queue. That's deliberate, so a broken ticket can't use up tokens in a loop. Nothing retries on its own.

## 6. Edge cases

- **A ticket moved to Done by hand while its PR is still open:** close skips it, because it's already in Done. Verify then runs against the base branch *without* the change and will likely FAIL. Let the factory move tickets to Done when the PR merges.
- **A ticket moved to Done by hand that the factory never built:** it still gets verified, as long as it has `factory-enabled`.
- **The container is killed mid-build:** a normal stop (SIGTERM) finishes the current stage first. A hard kill can leave `factory-building` on the ticket, which keeps it out of the build queue for good. Remove `factory-building`, move the ticket to To Do and check `factory/KEY` for a half-pushed branch.
- **Dry run** (`DRY_RUN=true`) changes no labels, so a long-running dry run rebuilds the same ticket every poll. Use it with `--once`.
- **One build at a time:** a ticket waits in To Do until any build ahead of it finishes. Review, close and verify for other tickets still run on every poll.
- **Instructions written inside a ticket** (about tools, credentials or skipping steps) are treated as data and ignored. The agent reports them in its summary.

## 7. Known gaps

- **Verification runs after merge**, so it can't stop a bad merge. Moving the verify stage before the human merge is a small change in [`index.ts`](../orchestrator/src/index.ts).
- **There is no fix-up loop.** Review comments and verifier FAILs are never fed back to a builder. Doing that would need a new stage that reruns the builder on the existing branch with those comments as input.
- **Ticket comments are never part of the input** ([section 1](#1-what-the-factory-reads-from-a-ticket)).
- **The builder decides when a ticket is too vague.** A ticket that looks clear but is wrong gets built from criteria the builder made up. The problem usually shows up only as UNTESTABLE or FAIL at verify.
