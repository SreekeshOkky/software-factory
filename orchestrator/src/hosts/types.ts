// The contract between the factory and a code host (GitHub, GitLab,
// Bitbucket, ...): where repos are cloned from and pushed to, and where pull
// requests (merge requests) are opened and reviewed. The stages only ever talk
// to a `CodeHost`, so a new vendor is one folder under src/hosts/ plus one line
// in the registry. See docs/adding-a-code-host.md.
import type { z } from "zod";
import type { RepoEntry } from "../config.js";
import type { VendorEnv } from "../vendor.js";

/** A pull request (merge request), in the shape the stages read. */
export interface PrInfo {
  /** The host's number for it (GitHub #12, GitLab !12, Bitbucket #12). */
  number: number;
  url: string;
  /** Map the host's states onto these: declined, rejected or superseded count as CLOSED. */
  state: "OPEN" | "CLOSED" | "MERGED";
  /** Source branch, e.g. `factory/KAN-12`. */
  headRefName: string;
  /** Commit SHA at the tip of the source branch. */
  headRefOid: string;
}

/** One review comment from the review agent. `line` is a new-side line number. */
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  severity?: string;
}

/** A git remote plus what the factory's own git process needs to reach it. */
export interface GitRemote {
  url: string;
  /**
   * Environment for factory-side `git clone` / `git push` (never for agent
   * commands). Use it for credentials and URL rewrites, e.g. through
   * GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n.
   */
  env: Record<string, string>;
}

/** Everything the factory does on a code host. Plain code calls these; agents never do. */
export interface CodeHost {
  /** Vendor id, the same as `repos[].host.type`. */
  readonly id: string;

  /** How the factory clones and pushes this repo. */
  remote(repo: RepoEntry): GitRemote;

  /** The newest PR from `branch`, in any state, or null. */
  findPr(repo: RepoEntry, branch: string): Promise<PrInfo | null>;

  /** Opens a PR, or returns the open one for `head` if there already is one. */
  createPr(repo: RepoEntry, pr: { head: string; base: string; title: string; body: string }): Promise<PrInfo>;

  /** The PR's unified diff (`git diff` format). */
  diff(repo: RepoEntry, pr: PrInfo): Promise<string>;

  /**
   * Posts the review agent's comments: inline where the host accepts the line,
   * the rest in the summary (see `splitComments` in hosts/diff.ts). Comment only:
   * never approve or request changes.
   */
  postReview(repo: RepoEntry, pr: PrInfo, summary: string, comments: ReviewComment[], diff: string): Promise<void>;

  /** A URL that shows a file committed on `branch` as an image in a PR description, e.g. a screenshot. */
  fileUrl(repo: RepoEntry, branch: string, path: string): string;

  /** Short text for the startup log, e.g. "github:owner/repo". */
  describe(repo: RepoEntry): string;
}

/** What a code-host vendor gets when the factory creates it. */
export interface HostInit extends VendorEnv {
  /** A private scratch directory for temporary files (bodies, payloads). */
  tmpDir: string;
}

/** One code-host vendor. Register it in src/hosts/index.ts. */
export interface CodeHostVendor {
  /** The value of `repos[].host.type`, kebab-case. */
  id: string;
  /** Human name for logs and errors, e.g. "GitHub". */
  name: string;
  /** Hostnames this vendor serves by default, so `host:` can be left out (e.g. ["github.com"]). */
  hostnames: string[];
  /** Validates a repo's `host:` block (without `type`). Runs when factory.config.yml loads. */
  repoConfig: z.ZodTypeAny;
  /** Builds the host. Called once at startup, and only if some repo uses this vendor. */
  create(init: HostInit): CodeHost;
}
