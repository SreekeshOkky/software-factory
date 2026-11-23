// Jira Cloud tracker. Every status change, label and comment goes through
// here: plain code, never an agent, decides workflow state.
// v2 endpoints are used for issue text and comments because they speak wiki
// markup strings instead of ADF JSON.
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import type { FactoryConfig, RepoEntry } from "../../config.js";
import { LABELS, type Labels } from "../../labels.js";
import { log } from "../../log.js";
import type { Issue, Queue, Tracker, TrackerVendor } from "../types.js";
import { mdToWiki } from "./markup.js";

export { mdToWiki } from "./markup.js";

/** A repo's `tracker:` block when `type: jira`. */
export const JiraRepoConfig = z.object({
  project: z.string().min(1),
  /** Route by component when one project feeds several repos. */
  component: z.string().optional(),
});
export type JiraRepoConfig = z.infer<typeof JiraRepoConfig>;

const repoScope = (repo: RepoEntry): JiraRepoConfig => JiraRepoConfig.parse(repo.tracker);

export interface JiraOptions {
  baseUrl: string;
  email: string;
  token: string;
  dryRun?: boolean;
  /** Needed by `find` (statuses, opt-in label). */
  cfg?: FactoryConfig;
  labels?: Labels;
  /** Atlassian Rovo MCP server for the builder; omit to turn it off. */
  rovoMcpUrl?: string;
  fetchImpl?: typeof fetch;
  /** Override backoff (tests). */
  retryDelayMs?: number;
}

export class Jira implements Tracker {
  readonly id = "jira";
  private auth: string;
  private f: typeof fetch;
  constructor(private o: JiraOptions) {
    this.auth = "Basic " + Buffer.from(`${o.email}:${o.token}`).toString("base64");
    this.f = o.fetchImpl ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const isForm = body instanceof FormData;
    const res = await this.fetchRetry(`${this.o.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.auth,
        Accept: "application/json",
        ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Jira ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Retries network failures (DNS, reset, laptop waking up) and 429/5xx, with backoff. */
  private async fetchRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
    for (let i = 1; ; i++) {
      try {
        const res = await this.f(url, init);
        if ((res.status === 429 || res.status >= 500) && i < attempts) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (e) {
        if (i >= attempts) throw new Error(`Jira unreachable after ${attempts} tries: ${(e as Error & { cause?: Error }).cause?.message ?? (e as Error).message}`);
        const wait = 2000 * 2 ** (i - 1);
        log.warn(`Jira request failed (${(e as Error & { cause?: Error }).cause?.message ?? (e as Error).message}); retry ${i}/${attempts - 1} in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, this.o.retryDelayMs ?? wait));
      }
    }
  }

  private mutating(what: string): boolean {
    if (this.o.dryRun) log.info(`[dry-run] jira: ${what}`);
    return !this.o.dryRun;
  }

  issueUrl(key: string): string {
    return `${this.o.baseUrl}/browse/${key}`;
  }

  describe(repo: RepoEntry): string {
    const s = repoScope(repo);
    return `jira:${s.project}${s.component ? `/${s.component}` : ""}`;
  }

  async find(queue: Queue, repo: RepoEntry): Promise<string[]> {
    if (!this.o.cfg) throw new Error("Jira.find needs `cfg` in JiraOptions");
    return this.search(jqlFor(this.o.cfg, repo, this.o.labels ?? LABELS)[queue]);
  }

  /** Runs a JQL query and returns every matching key, across pages. */
  async search(jql: string): Promise<string[]> {
    const keys: string[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.req<{ issues: { key: string }[]; nextPageToken?: string }>("POST", "/rest/api/3/search/jql", {
        jql,
        fields: ["key"],
        maxResults: 50,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      keys.push(...page.issues.map((i) => i.key));
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);
    return keys;
  }

  async getIssue(key: string): Promise<Issue> {
    type Raw = {
      key: string;
      fields: {
        summary: string;
        description: string | null;
        status: { name: string };
        issuetype: { name: string };
        labels: string[];
        components: { name: string }[];
        project: { key: string };
      };
    };
    const r = await this.req<Raw>(
      "GET",
      `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,labels,components,project`,
    );
    return {
      key: r.key,
      project: r.fields.project.key,
      summary: r.fields.summary,
      description: r.fields.description ?? "",
      descriptionFormat: "Jira wiki markup",
      status: r.fields.status.name,
      issueType: r.fields.issuetype.name,
      labels: r.fields.labels,
      components: r.fields.components.map((c) => c.name),
      url: this.issueUrl(r.key),
    };
  }

  /** By project, preferring a repo whose component the ticket has over one with no component. */
  route(repos: RepoEntry[], issue: Pick<Issue, "project" | "components">): RepoEntry | undefined {
    const inProject = repos.filter((r) => repoScope(r).project === issue.project);
    return (
      inProject.find((r) => {
        const c = repoScope(r).component;
        return c && issue.components.includes(c);
      }) ?? inProject.find((r) => !repoScope(r).component)
    );
  }

  /** Moves an issue to the named status if a transition to it exists. Returns false if none does. */
  async transitionTo(key: string, statusName: string): Promise<boolean> {
    const { transitions } = await this.req<{ transitions: { id: string; name: string; to: { name: string } }[] }>(
      "GET",
      `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
    );
    const t = transitions.find((x) => x.to.name.toLowerCase() === statusName.toLowerCase());
    if (!t) {
      log.warn(`${key}: no transition to "${statusName}" (available: ${transitions.map((x) => x.to.name).join(", ")})`);
      return false;
    }
    if (this.mutating(`${key} -> ${statusName}`)) {
      await this.req("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    }
    return true;
  }

  async updateLabels(key: string, add: string[] = [], remove: string[] = []): Promise<void> {
    const ops = [...add.map((l) => ({ add: l })), ...remove.map((l) => ({ remove: l }))];
    if (!ops.length || !this.mutating(`${key} labels +[${add}] -[${remove}]`)) return;
    await this.req("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, { update: { labels: ops } });
  }

  /** Posts a comment. `markdown` is converted to Jira wiki markup. */
  async comment(key: string, markdown: string): Promise<void> {
    if (!this.mutating(`${key} comment: ${markdown.slice(0, 80)}...`)) return;
    await this.req("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body: mdToWiki(markdown) });
  }

  async attach(key: string, files: string[]): Promise<void> {
    if (!files.length || !this.mutating(`${key} attach ${files.map((f) => basename(f)).join(", ")}`)) return;
    const form = new FormData();
    for (const f of files) form.append("file", await openAsBlob(f), basename(f));
    await this.req("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, form, { "X-Atlassian-Token": "no-check" });
  }

  /** The Atlassian Rovo MCP server, if enabled, so the builder can read linked issues and comments. */
  agentMcpServers(): Record<string, object> {
    if (!this.o.rovoMcpUrl) return {};
    return { atlassian: { type: "http", url: this.o.rovoMcpUrl, headers: { Authorization: this.auth } } };
  }
}

/** JQL fragments shared by every query for a repo. */
function scope(cfg: FactoryConfig, repo: RepoEntry): string {
  const s = repoScope(repo);
  const parts = [`project = "${s.project}"`, `labels = "${cfg.enable_label}"`];
  if (s.component) parts.push(`component = "${s.component}"`);
  return parts.join(" AND ");
}

const notLabels = (...l: string[]) => `labels not in (${l.map((x) => `"${x}"`).join(", ")})`;

export function jqlFor(cfg: FactoryConfig, repo: RepoEntry, L: Labels): Record<Queue, string> {
  const s = scope(cfg, repo);
  return {
    toBuild: `${s} AND status = "${cfg.statuses.todo}" AND ${notLabels(L.building, L.prOpen, L.blocked)} ORDER BY priority DESC, created ASC`,
    toReview: `${s} AND labels = "${L.prOpen}" AND ${notLabels(L.reviewed, L.merged, L.blocked)} ORDER BY updated ASC`,
    toClose: `${s} AND labels = "${L.prOpen}" AND ${notLabels(L.merged, L.blocked)} AND status != "${cfg.statuses.done}"`,
    toVerify: `${s} AND status = "${cfg.statuses.done}" AND ${notLabels(L.verified, L.verifyFailed, L.blocked)} ORDER BY resolved ASC`,
  };
}

export const jira: TrackerVendor = {
  id: "jira",
  name: "Jira Cloud",
  repoConfig: JiraRepoConfig,
  create: ({ cfg, labels, dryRun, requireEnv, env }) =>
    new Jira({
      baseUrl: requireEnv("JIRA_BASE_URL").replace(/\/+$/, ""),
      email: requireEnv("JIRA_EMAIL"),
      token: requireEnv("JIRA_API_TOKEN"),
      dryRun,
      cfg,
      labels,
      rovoMcpUrl: env("JIRA_ROVO_MCP") === "true" ? (env("JIRA_ROVO_MCP_URL") ?? "https://mcp.atlassian.com/v1/mcp") : undefined,
    }),
};
