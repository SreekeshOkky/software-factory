// The contract between the factory and a ticket tracker (Jira, GitHub Issues,
// GitLab, Linear, Asana, ...). The stages only ever talk to a `Tracker`, so a
// new vendor is one folder under src/trackers/ plus one line in the registry.
// See docs/adding-a-tracker.md.
import type { z } from "zod";
import type { FactoryConfig, RepoEntry } from "../config.js";
import type { Labels } from "../labels.js";
import type { VendorEnv } from "../vendor.js";

/** A ticket, in the shape every stage and prompt reads. */
export interface Issue {
  /** The tracker's own id for the ticket, e.g. "KAN-12" or "42". Used in branch names (`factory/<key>`), so keep it short and path-safe. */
  key: string;
  /** The container the ticket lives in (Jira project, GitHub repo, Asana project, ...). Used for routing. */
  project: string;
  summary: string;
  /** The ticket body, in the tracker's own markup. */
  description: string;
  /** What the description is written in, shown to agents, e.g. "Jira wiki markup" or "Markdown". */
  descriptionFormat: string;
  /** Current workflow status name. */
  status: string;
  /** Ticket type, matched by `ticket_modes[].match.issue_types`. Empty if the tracker has no types. */
  issueType: string;
  labels: string[];
  /** Sub-areas inside the project, used for routing (Jira components, ...). Empty if the tracker has none. */
  components: string[];
  /** Link a human can open. */
  url: string;
}

/**
 * The four work queues the poll loop drains, in this order, for each repo.
 * Every query is limited to the repo's scope and the `enable_label`, and skips
 * tickets labelled `factory-blocked`.
 *
 * - `toClose`:  labelled `factory-pr-open`, not `factory-merged`, status is not `done`.
 * - `toVerify`: status is `done`, not `factory-verified` or `factory-verify-failed`. Oldest resolved first.
 * - `toReview`: labelled `factory-pr-open`, not `factory-reviewed` or `factory-merged`. Least recently updated first.
 * - `toBuild`:  status is `todo`, not `factory-building` or `factory-pr-open`. Highest priority, then oldest, first.
 */
export type Queue = "toClose" | "toVerify" | "toReview" | "toBuild";

/** Everything the factory does to tickets. Plain code calls these; agents never do. */
export interface Tracker {
  /** Vendor id, the same as `repos[].tracker.type`. */
  readonly id: string;

  /** Ticket keys in `queue` for this repo, in the order to work on them. */
  find(queue: Queue, repo: RepoEntry): Promise<string[]>;

  getIssue(key: string): Promise<Issue>;

  /**
   * Picks, among `repos` (only those using this tracker), the one a ticket belongs to.
   * The poll loop skips a ticket whose route is not the repo it was found for.
   */
  route(repos: RepoEntry[], issue: Issue): RepoEntry | undefined;

  /** Moves the ticket to the named status. Returns false (and does nothing) if it can't get there. */
  transitionTo(key: string, status: string): Promise<boolean>;

  updateLabels(key: string, add?: string[], remove?: string[]): Promise<void>;

  /** Posts a comment. `markdown` is GitHub-flavoured Markdown; convert it to the tracker's markup. */
  comment(key: string, markdown: string): Promise<void>;

  /** Attaches files (PNG screenshots) to the ticket. */
  attach(key: string, files: string[]): Promise<void>;

  /** Short text for the startup log, e.g. "jira:KAN/web". */
  describe(repo: RepoEntry): string;

  /**
   * Optional MCP servers to give the builder agent, keyed by server name, in
   * Claude Code's `mcpServers` format. Their tools are allowed as `mcp__<name>__*`.
   */
  agentMcpServers?(): Record<string, object>;
}

/** What a vendor gets when the factory creates its tracker. */
export interface VendorInit extends VendorEnv {
  cfg: FactoryConfig;
  labels: Labels;
}

/** One tracker vendor. Register it in src/trackers/index.ts. */
export interface TrackerVendor {
  /** The value of `repos[].tracker.type`, kebab-case. */
  id: string;
  /** Human name for logs and errors, e.g. "Jira Cloud". */
  name: string;
  /** Validates a repo's `tracker:` block (without `type`). Runs when factory.config.yml loads. */
  repoConfig: z.ZodTypeAny;
  /** Builds the tracker. Called once at startup, and only if some repo uses this vendor. */
  create(init: VendorInit): Tracker;
}
