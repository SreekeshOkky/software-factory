---
name: red-green
description: The factory's red-green TDD sequence for implementing a Jira ticket. Use whenever implementing a ticket in the factory. Defines the exact commits the factory verifies.
---

# Red-green for factory tickets

The factory checks your work mechanically after you finish:

1. It finds the commit whose message contains the trailer `Factory-Phase: red`.
2. It checks that commit out, runs the repo's test command, and **expects it to fail**.
3. It checks out your final commit, runs the test command again, and **expects it to pass**.
4. It checks that you changed no protected paths.

If any of these doesn't hold, your work is thrown away and the ticket is
marked blocked. Follow the sequence exactly.

## Steps

### 0. Understand
- Read `CLAUDE.md` and `factory.yml`.
- Read the ticket in your prompt. Number its acceptance criteria. If it
  has none, derive them from the description and say so in your summary.
- The prompt includes a **mode recipe** from `factory.yml` (for example,
  `default` for code, `content` for a blog post). It says what the red tests
  must assert for this kind of ticket. Follow it.
- Find the existing tests closest to the area you'll change and copy their
  style.

### 1. Red
- Write tests, at least one per criterion, that fail **because the
  feature doesn't exist yet**. Not because of a typo, a missing import of
  a test helper, or a syntax error.
- Prefer the cheapest test that proves the criterion: unit, then component,
  then end-to-end. Use end-to-end (Playwright) for behaviour a user sees in
  the browser.
- Test outcomes, not messages: after "save", reload and assert the saved
  value, don't assert a toast.
- Run the test command from `factory.yml`. Confirm the new tests fail and
  read the failure messages. They should describe the missing behaviour.
- Commit only the tests (and any test-only fixtures):

  ```
  <prefix>: add failing tests for <ticket summary>

  Factory-Phase: red
  Jira: <KEY>
  ```

  Use the repo's commit prefix style from `factory.yml` (`commit_style.prefixes`),
  usually `test:` or the closest match. Exactly one commit gets the red trailer.

### 2. Green
- Write the smallest implementation that makes the tests pass, following
  CLAUDE.md's conventions.
- Run the **full** test command, not only your new tests. Everything must
  pass, including `check`/type-check steps if the test command includes them.
- Commit:

  ```
  <prefix>: <imperative description of the change>

  Factory-Phase: green
  Jira: <KEY>
  ```

### 3. Refactor (optional)
- Clean up while keeping the suite green. Commit each step with
  `Factory-Phase: refactor`. Re-run the full test command before every commit.

## Don'ts
- Don't modify or delete existing tests to make them pass. If one
  legitimately needs changing because the ticket changes that behaviour,
  change it in the red commit and explain why in your summary.
- Don't mark tests skipped, `.only`, or `test.fixme`.
- Don't amend or rebase the red commit after it's made.
- Don't commit build output, screenshots, or files under `.factory/` (the
  factory adds evidence itself).
