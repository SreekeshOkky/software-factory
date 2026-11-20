// GitHub through the gh CLI. The builder token opens PRs; the reviewer token
// posts reviews (GitHub won't let an author review their own PR).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { must, run } from "./exec.js";
import { log } from "./log.js";

export interface PrInfo {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefName: string;
  headRefOid: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  severity?: string;
}

/** "git@github.com:owner/repo.git" or "https://github.com/owner/repo" -> "owner/repo" */
export function slugFromGitUrl(url: string): string {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`not a GitHub URL: ${url}`);
  return `${m[1]}/${m[2]}`;
}

/** New-side line numbers per file that GitHub accepts for inline comments (added + context lines). */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const ok = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  let n = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git")) {
      lines = undefined;
      continue;
    }
    if (l.startsWith("+++ ")) {
      const path = l.slice(4).replace(/^b\//, "");
      lines = path === "/dev/null" ? undefined : new Set();
      if (lines) ok.set(path, lines);
      continue;
    }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (!lines || l.startsWith("--- ") || l.startsWith("\\")) continue;
    if (l.startsWith("+") || l.startsWith(" ")) lines.add(n++);
  }
  return ok;
}

/** Splits review comments into ones GitHub will accept inline and ones that must go in the body. */
export function splitComments(diff: string, comments: ReviewComment[]): { inline: ReviewComment[]; folded: ReviewComment[] } {
  const ok = commentableLines(diff);
  const inline: ReviewComment[] = [];
  const folded: ReviewComment[] = [];
  for (const c of comments) (ok.get(c.path)?.has(c.line) ? inline : folded).push(c);
  return { inline, folded };
}

const bullet = (c: ReviewComment) => `- \`${c.path}:${c.line}\` ${c.severity ? `**${c.severity}** ` : ""}${c.body}`;

export class GitHub {
  constructor(private o: { token: string; reviewerToken: string; dryRun?: boolean; tmpDir: string }) {}

  private gh(args: string[], token = this.o.token, cwd?: string) {
    return must("gh", args, { env: { GH_TOKEN: token }, cwd });
  }

  async findPr(repo: string, branch: string): Promise<PrInfo | null> {
    const out = await this.gh([
      "pr", "list", "-R", repo, "--head", branch, "--state", "all", "--limit", "1",
      "--json", "number,url,state,headRefName,headRefOid",
    ]);
    const list = JSON.parse(out || "[]") as PrInfo[];
    return list[0] ?? null;
  }

  async createPr(repo: string, o: { head: string; base: string; title: string; body: string }): Promise<PrInfo> {
    const existing = await this.findPr(repo, o.head);
    if (existing && existing.state === "OPEN") return existing;
    if (this.o.dryRun) {
      log.info(`[dry-run] gh pr create ${repo} ${o.head} -> ${o.base}: ${o.title}`);
      return { number: 0, url: "(dry-run)", state: "OPEN", headRefName: o.head, headRefOid: "" };
    }
    const bodyFile = join(this.o.tmpDir, `pr-body-${Date.now()}.md`);
    writeFileSync(bodyFile, o.body);
    await this.gh(["pr", "create", "-R", repo, "--head", o.head, "--base", o.base, "--title", o.title, "--body-file", bodyFile]);
    const pr = await this.findPr(repo, o.head);
    if (!pr) throw new Error(`PR for ${o.head} not found after create`);
    return pr;
  }

  async diff(repo: string, n: number): Promise<string> {
    return this.gh(["pr", "diff", String(n), "-R", repo, "--patch"]);
  }

  async comment(repo: string, n: number, body: string): Promise<void> {
    if (this.o.dryRun) return log.info(`[dry-run] gh pr comment ${repo}#${n}`);
    const f = join(this.o.tmpDir, `comment-${Date.now()}.md`);
    writeFileSync(f, body);
    await this.gh(["pr", "comment", String(n), "-R", repo, "--body-file", f], this.o.reviewerToken);
  }

  /**
   * Posts a COMMENT review with inline comments. If GitHub rejects a line
   * (422: not in the diff), retries with the comments folded into the body.
   */
  async postReview(repo: string, n: number, commitId: string, summary: string, comments: ReviewComment[], diff = ""): Promise<void> {
    const toInline = (c: ReviewComment) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT",
      body: c.severity ? `**${c.severity}**: ${c.body}` : c.body,
    });
    if (this.o.dryRun) return log.info(`[dry-run] review ${repo}#${n}: ${comments.length} comments`);
    const send = async (payload: object) => {
      const f = join(this.o.tmpDir, `review-${Date.now()}.json`);
      writeFileSync(f, JSON.stringify(payload));
      return run("gh", ["api", "-X", "POST", `repos/${repo}/pulls/${n}/reviews`, "--input", f], { env: { GH_TOKEN: this.o.reviewerToken } });
    };
    // One comment on a line outside the diff makes GitHub reject the whole review (422).
    const { inline, folded } = diff ? splitComments(diff, comments) : { inline: comments, folded: [] };
    if (folded.length) log.warn(`${folded.length} review comment(s) point outside the diff; moving them to the review body`);
    const withFolded = folded.length ? `${summary}\n\n### Comments on lines outside the diff\n${folded.map(bullet).join("\n")}` : summary;
    const first = await send({ commit_id: commitId, event: "COMMENT", body: withFolded, comments: inline.map(toInline) });
    if (first.code === 0) return;
    log.warn(`inline review rejected, folding all comments into body: ${(first.stderr || first.stdout).slice(0, 300)}`);
    const all = comments.length ? `${summary}\n\n### Comments\n${comments.map(bullet).join("\n")}` : summary;
    const second = await send({ commit_id: commitId, event: "COMMENT", body: all });
    if (second.code !== 0) throw new Error(`review post failed: ${second.stderr.slice(0, 500)}`);
  }
}
