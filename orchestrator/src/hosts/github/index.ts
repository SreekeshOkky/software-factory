// GitHub through the gh CLI. The builder token opens PRs; the reviewer token
// posts reviews (GitHub won't let an author review their own PR).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RepoEntry } from "../../config.js";
import { must, run } from "../../exec.js";
import { log } from "../../log.js";
import { inlineBody, splitComments, withComments } from "../diff.js";
import { basicAuthGitEnv } from "../git.js";
import type { CodeHost, CodeHostVendor, GitRemote, PrInfo, ReviewComment } from "../types.js";

export type { PrInfo, ReviewComment } from "../types.js";

/** "git@github.com:owner/repo.git" or "https://github.com/owner/repo" -> "owner/repo" */
export function slugFromGitUrl(url: string): string {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`not a GitHub URL: ${url}`);
  return `${m[1]}/${m[2]}`;
}

/** A repo's `host:` block when `type: github`. No options yet: github.com only. */
export const GitHubRepoConfig = z.object({});

export interface GitHubOptions {
  token: string;
  reviewerToken: string;
  dryRun?: boolean;
  tmpDir: string;
}

export class GitHub implements CodeHost {
  readonly id = "github";
  constructor(private o: GitHubOptions) {}

  private gh(args: string[], token = this.o.token, cwd?: string) {
    return must("gh", args, { env: { GH_TOKEN: token }, cwd });
  }

  remote(repo: RepoEntry): GitRemote {
    return { url: repo.git, env: basicAuthGitEnv("github.com", "x-access-token", this.o.token) };
  }

  describe(repo: RepoEntry): string {
    return `github:${slugFromGitUrl(repo.git)}`;
  }

  fileUrl(repo: RepoEntry, branch: string, path: string): string {
    return `https://github.com/${slugFromGitUrl(repo.git)}/blob/${branch}/${path}?raw=true`;
  }

  async findPr(repo: RepoEntry, branch: string): Promise<PrInfo | null> {
    const out = await this.gh([
      "pr", "list", "-R", slugFromGitUrl(repo.git), "--head", branch, "--state", "all", "--limit", "1",
      "--json", "number,url,state,headRefName,headRefOid",
    ]);
    const list = JSON.parse(out || "[]") as PrInfo[];
    return list[0] ?? null;
  }

  async createPr(repo: RepoEntry, o: { head: string; base: string; title: string; body: string }): Promise<PrInfo> {
    const slug = slugFromGitUrl(repo.git);
    const existing = await this.findPr(repo, o.head);
    if (existing && existing.state === "OPEN") return existing;
    if (this.o.dryRun) {
      log.info(`[dry-run] gh pr create ${slug} ${o.head} -> ${o.base}: ${o.title}`);
      return { number: 0, url: "(dry-run)", state: "OPEN", headRefName: o.head, headRefOid: "" };
    }
    const bodyFile = join(this.o.tmpDir, `pr-body-${Date.now()}.md`);
    writeFileSync(bodyFile, o.body);
    await this.gh(["pr", "create", "-R", slug, "--head", o.head, "--base", o.base, "--title", o.title, "--body-file", bodyFile]);
    const pr = await this.findPr(repo, o.head);
    if (!pr) throw new Error(`PR for ${o.head} not found after create`);
    return pr;
  }

  async diff(repo: RepoEntry, pr: PrInfo): Promise<string> {
    return this.gh(["pr", "diff", String(pr.number), "-R", slugFromGitUrl(repo.git), "--patch"]);
  }

  /**
   * Posts a COMMENT review with inline comments. If GitHub rejects a line
   * (422: not in the diff), retries with the comments folded into the body.
   */
  async postReview(repo: RepoEntry, pr: PrInfo, summary: string, comments: ReviewComment[], diff = ""): Promise<void> {
    const slug = slugFromGitUrl(repo.git);
    const toInline = (c: ReviewComment) => ({ path: c.path, line: c.line, side: "RIGHT", body: inlineBody(c) });
    if (this.o.dryRun) return log.info(`[dry-run] review ${slug}#${pr.number}: ${comments.length} comments`);
    const send = async (payload: object) => {
      const f = join(this.o.tmpDir, `review-${Date.now()}.json`);
      writeFileSync(f, JSON.stringify(payload));
      return run("gh", ["api", "-X", "POST", `repos/${slug}/pulls/${pr.number}/reviews`, "--input", f], { env: { GH_TOKEN: this.o.reviewerToken } });
    };
    // One comment on a line outside the diff makes GitHub reject the whole review (422).
    const { inline, folded } = diff ? splitComments(diff, comments) : { inline: comments, folded: [] };
    if (folded.length) log.warn(`${folded.length} review comment(s) point outside the diff; moving them to the review body`);
    const first = await send({ commit_id: pr.headRefOid, event: "COMMENT", body: withComments(summary, folded), comments: inline.map(toInline) });
    if (first.code === 0) return;
    log.warn(`inline review rejected, folding all comments into body: ${(first.stderr || first.stdout).slice(0, 300)}`);
    const second = await send({ commit_id: pr.headRefOid, event: "COMMENT", body: withComments(summary, comments, "Comments") });
    if (second.code !== 0) throw new Error(`review post failed: ${second.stderr.slice(0, 500)}`);
  }
}

export const github: CodeHostVendor = {
  id: "github",
  name: "GitHub",
  hostnames: ["github.com"],
  repoConfig: GitHubRepoConfig,
  create: ({ requireEnv, env, dryRun, tmpDir }) => {
    const token = requireEnv("GH_TOKEN");
    return new GitHub({ token, reviewerToken: env("GH_REVIEWER_TOKEN") ?? token, dryRun, tmpDir });
  },
};
