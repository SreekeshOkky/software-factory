// Jira Cloud REST client. Every status change, label and comment goes through
// here: plain code, never an agent, decides workflow state.
// v2 endpoints are used for issue text and comments because they speak wiki
// markup strings instead of ADF JSON.
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import type { FactoryConfig, RepoEntry } from "./config.js";
import { log } from "./log.js";

export interface Issue {
  key: string;
  project: string;
  summary: string;
  description: string;
  status: string;
  issueType: string;
  labels: string[];
  components: string[];
  url: string;
}

export interface JiraOptions {
  baseUrl: string;
  email: string;
  token: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  /** Override backoff (tests). */
  retryDelayMs?: number;
}

export class Jira {
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
      status: r.fields.status.name,
      issueType: r.fields.issuetype.name,
      labels: r.fields.labels,
      components: r.fields.components.map((c) => c.name),
      url: this.issueUrl(r.key),
    };
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
}

/** JQL fragments shared by every query for a repo. */
function scope(cfg: FactoryConfig, repo: RepoEntry): string {
  const parts = [`project = "${repo.jira.project}"`, `labels = "${cfg.enable_label}"`];
  if (repo.jira.component) parts.push(`component = "${repo.jira.component}"`);
  return parts.join(" AND ");
}

const notLabels = (...l: string[]) => `labels not in (${l.map((x) => `"${x}"`).join(", ")})`;

export function jqlFor(cfg: FactoryConfig, repo: RepoEntry, L: Record<string, string>) {
  const s = scope(cfg, repo);
  return {
    toBuild: `${s} AND status = "${cfg.statuses.todo}" AND ${notLabels(L.building!, L.prOpen!, L.blocked!)} ORDER BY priority DESC, created ASC`,
    toReview: `${s} AND labels = "${L.prOpen}" AND ${notLabels(L.reviewed!, L.merged!, L.blocked!)} ORDER BY updated ASC`,
    toClose: `${s} AND labels = "${L.prOpen}" AND ${notLabels(L.merged!, L.blocked!)} AND status != "${cfg.statuses.done}"`,
    toVerify: `${s} AND status = "${cfg.statuses.done}" AND ${notLabels(L.verified!, L.verifyFailed!, L.blocked!)} ORDER BY resolved ASC`,
  };
}

/** Minimal Markdown -> Jira wiki markup: headings, bold, code, links, fenced code, tables. */
export function mdToWiki(md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let inCode = false;
  let tableHeader = true;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      out.push(inCode ? "{code}" : fence[1] ? `{code:${fence[1]}}` : "{code}");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // separator row
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()) || " ");
      out.push(tableHeader ? `||${cells.join("||")}||` : `|${cells.join("|")}|`);
      tableHeader = false;
      continue;
    }
    tableHeader = true;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`h${h[1]!.length}. ${inline(h[2]!)}`);
      continue;
    }
    out.push(inline(line.replace(/^(\s*)[-*]\s+/, (_m, sp: string) => `${"*".repeat(sp.length / 2 + 1)} `)));
  }
  return out.join("\n");
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "{{$1}}")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "[$1|$2]");
}
