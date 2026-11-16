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
  async postReview(repo: string, n: number, commitId: string, summary: string, comments: ReviewComment[]): Promise<void> {
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
    const first = await send({ commit_id: commitId, event: "COMMENT", body: summary, comments: comments.map(toInline) });
    if (first.code === 0) return;
    log.warn(`inline review rejected, folding comments into body: ${first.stderr.slice(0, 300)}`);
    const folded = comments.length
      ? `${summary}\n\n### Comments\n${comments.map((c) => `- \`${c.path}:${c.line}\` ${c.severity ? `**${c.severity}** ` : ""}${c.body}`).join("\n")}`
      : summary;
    const second = await send({ commit_id: commitId, event: "COMMENT", body: folded });
    if (second.code !== 0) throw new Error(`review post failed: ${second.stderr.slice(0, 500)}`);
  }
}
