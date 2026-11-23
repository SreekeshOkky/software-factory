# Adding a code host

A **code host** is where a repo's code lives: the factory clones it, pushes `factory/*` branches to it, opens pull requests (merge requests) and posts the review agent's comments there. GitHub is the only one today. Adding GitLab, Bitbucket or a self-hosted server means writing **one folder and one registry line**. The stages don't change.

It's separate from the [ticket tracker](adding-a-tracker.md), so any tracker works with any host: Jira tickets with code on GitLab, for example, is just config.

```
orchestrator/src/hosts/
├── types.ts          the contract: CodeHost, PrInfo, ReviewComment, GitRemote, CodeHostVendor
├── index.ts          the registry (VENDORS), hostname inference, one instance per host type
├── diff.ts           shared: which diff lines accept inline comments, folding the rest into the summary
├── git.ts            shared: hostname and path from a git URL, and git credentials through the environment
└── github/
    └── index.ts      GitHub through the gh CLI, and its CodeHostVendor export
```

A repo picks its host in `factory.config.yml`. You can leave `host:` out when the git URL is on a hostname a vendor lists in `hostnames` (for example `github.com`):

```yaml
repos:
  - name: portfolio
    git: git@gitlab.com:team/portfolio.git
    host: { type: gitlab }               # the vendor id, plus that vendor's options
    tracker: { type: jira, project: KAN }
```

## Steps

1. **Create `orchestrator/src/hosts/<id>/index.ts`.** `<id>` is kebab-case, e.g. `gitlab` or `bitbucket`.
2. **Write a class that implements `CodeHost`** (see [the contract](#the-contract)).
3. **Export a `CodeHostVendor`** with:
   - `id`, the same as the folder name;
   - `name`, used in errors;
   - `hostnames`, the SaaS hostnames you serve, so `host:` can be left out for them;
   - `repoConfig`, a zod schema for the repo's `host:` block, e.g. a `base_url` for self-hosted servers;
   - `create(init)`, which reads tokens with `init.requireEnv(...)`.
4. **Register it** in `orchestrator/src/hosts/index.ts`:
   ```ts
   import { gitlab } from "./gitlab/index.js";
   export const VENDORS = { [github.id]: github, [gitlab.id]: gitlab };
   ```
5. **Add tests** in `orchestrator/test/host-<id>.test.ts`, following the [checklist](#tests).
6. **Document it:**
   - add its environment variables to `.env.example` and the README's Environment table;
   - add a short setup section for its token and the permissions it needs;
   - add its `host:` options to the README's `repos[].host` row.

The registry test in [`hosts.test.ts`](../orchestrator/test/hosts.test.ts) checks that every registered vendor's key matches its `id`.

## The contract

All of it is in [`types.ts`](../orchestrator/src/hosts/types.ts). Every method takes the `RepoEntry`, so work out the project or repo id from `repo.git` (the `gitPath()` helper handles GitLab subgroups) or from your `host:` options.

| Method | What it must do |
| --- | --- |
| `remote(repo)` | Return the clone URL plus the **environment** that gives the factory's own `git clone` and `git push` access. Use `basicAuthGitEnv(hostname, username, token)` from `git.ts`: it sets an auth header for that host and rewrites `git@host:` SSH URLs to HTTPS, through `GIT_CONFIG_*` variables, so no file holds the token. |
| `findPr(repo, branch)` | Return the newest PR from that source branch, in **any** state, or `null`. The close stage relies on seeing merged and closed ones. |
| `createPr(repo, pr)` | Open a PR, or return the existing **open** one for that branch. Rebuilds force-push the same branch, so this gets called again. In dry run, log and return a placeholder, as GitHub does. |
| `diff(repo, pr)` | Return the PR's unified diff (`diff --git` format), as the reviewer reads it and `diff.ts` parses it. |
| `postReview(repo, pr, summary, comments, diff)` | Post the comments **without approving or requesting changes**. Post them inline where the line is in the diff (`splitComments`), and fold the rest into the summary (`withComments`). If the host rejects an inline comment, fall back to posting everything in the summary rather than failing. Post as the reviewer account if the vendor has one. |
| `fileUrl(repo, branch, path)` | Return a link that shows a committed screenshot as an image in the PR description. The build stage commits screenshots under `.factory/evidence/<KEY>/` and links them with this. |
| `describe(repo)` | Return a short label for the startup log, e.g. `gitlab:team/portfolio`. |

Map the host's PR states to `OPEN`, `CLOSED` and `MERGED`. Declined, locked or superseded all count as `CLOSED`, which blocks the ticket so a human looks at it.

## Notes for GitLab and Bitbucket

Check these against the current API docs while you build. They're starting points, not a spec.

| | GitLab (gitlab.com or self-managed) | Bitbucket Cloud |
| --- | --- | --- |
| Project id | URL-encoded path (`team%2Fsub%2Frepo`), from `gitPath(repo.git)` | `workspace/repo` |
| Git username for `basicAuthGitEnv` | `oauth2`, with a project, group or personal access token | Depends on the token type: access tokens and API tokens use different usernames. Check Bitbucket's docs for the one you pick. |
| Find a PR | List merge requests filtered by `source_branch`, any state | List pull requests with a `source.branch.name` query, asking for every state |
| Review comments | Discussions with a `position`. It needs the MR's `diff_refs` (base, start and head SHA) plus `new_path` and `new_line`. Post the summary as a note. | Comments with `inline: { path, to }`, posted one by one. Post the summary as a plain comment. |
| States | `opened` / `closed` / `merged` / `locked` | `OPEN` / `MERGED` / `DECLINED` / `SUPERSEDED` |
| Screenshot link | `https://<host>/<path>/-/raw/<branch>/<file>`. Or upload through the project uploads API and link that. | `https://bitbucket.org/<ws>/<repo>/raw/<branch>/<file>`. Check that it shows for viewers of a private repo. If not, link the file instead of embedding it. |
| Self-hosted | Take a `base_url` in `repoConfig`, and leave `hostnames` as `["gitlab.com"]` | Bitbucket Data Center has a different API, so make it a separate vendor (`bitbucket-dc`) |

Plain `fetch` against the REST API is fine. You don't need a CLI in the image. Copy the retry and backoff pattern from `trackers/jira/index.ts` (`fetchRetry`).

## Rules every code host follows

- **Tokens never reach the agent.** Use them only in API calls and in `remote().env`, which the factory passes to its own `git clone` and `git push`. Never write them into a URL, a git config file or the workspace. The agent clones from a local copy, and the push goes from a fresh repo the factory owns, so neither ever sees `remote().env`.
- **Push only `factory/*` branches.** `pushBranch` enforces this. Don't add another way to push.
- **Comment only.** The review agent never approves or merges. A human does.
- **Dry run:** when `init.dryRun` is true, log and skip PR creation and review posting. Reads still happen. Pushes are already skipped by the stages.
- **Write temporary files** (bodies, payloads) to `init.tmpDir`, which is private to the factory.
- **No vendor-specific code outside your folder.** If a stage needs something new, add an optional method to `CodeHost` and implement it for GitHub too.

## Tests

Use a fake `fetch` or stub the CLI. At minimum, cover:

- [ ] `remote()`: the env sets the auth header and the SSH rewrite for your hostname. `hosts.test.ts` shows how to read it back with `git config`.
- [ ] `findPr` maps every host state onto `OPEN` / `CLOSED` / `MERGED`, and returns `null` when there's no PR.
- [ ] `createPr` returns the existing open PR instead of opening a second one.
- [ ] `postReview` folds comments outside the diff into the summary, and falls back to summary-only if the host rejects inline comments.
- [ ] Dry run makes no write calls.
- [ ] `fileUrl` builds the right link, including GitLab subgroups.
- [ ] Your `repoConfig` rejects bad options, and `hostnames` inference picks your vendor.

Then run:

```bash
cd orchestrator && npm test && npm run typecheck
```

Finally, run one real tick against a test repo:

```bash
DRY_RUN=true docker compose run --rm factory node /app/orchestrator/dist/index.js --once
```
