// PR open -> review agent reads ticket + diff + CLAUDE.md -> factory posts its comments.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastJsonBlock, runClaude } from "../claude.js";
import { LABELS, type RepoEntry } from "../config.js";
import type { ReviewComment } from "../hosts/index.js";
import type { Issue } from "../trackers/index.js";
import { reviewPrompt } from "../prompts.js";
import { branchFor, freshClone } from "../workspace.js";
import { Blocked, hostFor, trackerFor, workDirFor, type Ctx } from "./context.js";

export interface ReviewOutput {
  summary: string;
  criteria?: { criterion: string; covered: boolean; test?: string; note?: string }[];
  comments: ReviewComment[];
}

export function parseReview(reply: string): ReviewOutput | null {
  const j = lastJsonBlock<ReviewOutput>(reply);
  if (!j || typeof j.summary !== "string") return null;
  const comments = (Array.isArray(j.comments) ? j.comments : []).filter(
    (c) => c && typeof c.path === "string" && Number.isInteger(c.line) && c.line > 0 && typeof c.body === "string",
  );
  return { summary: j.summary, criteria: j.criteria, comments };
}

export function reviewBody(r: ReviewOutput): string {
  const rows = (r.criteria ?? []).map((c) => `| ${c.criterion} | ${c.covered ? "yes" : "**no**"} | ${c.test ?? ""} | ${c.note ?? ""} |`);
  return [
    "## Factory review",
    "",
    r.summary,
    rows.length ? `\n| Criterion | Tested | Test | Note |\n| --- | --- | --- | --- |\n${rows.join("\n")}` : "",
    "",
    "_Automated review. It comments only; a human approves and merges._",
  ].join("\n");
}

export async function reviewStage(ctx: Ctx, repo: RepoEntry, issue: Issue): Promise<void> {
  const { env, cfg, state } = ctx;
  const host = hostFor(ctx, repo);
  const tracker = trackerFor(ctx, repo);
  const pr = await host.findPr(repo, branchFor(issue.key));
  if (!pr) throw new Blocked(`Label \`${LABELS.prOpen}\` is set but no PR exists for branch \`${branchFor(issue.key)}\`.`);
  if (pr.state !== "OPEN") return; // close stage handles merged/closed PRs

  const step = (s: string) => state.step(issue.key, repo.name, "review", s);
  step(`cloning PR #${pr.number}`);
  const dir = workDirFor(ctx, repo, issue.key, "review");
  await freshClone(host.remote(repo), dir, pr.headRefName);
  const diffPath = join(`${dir}-diff.patch`);
  const diff = await host.diff(repo, pr);
  writeFileSync(diffPath, diff);

  step("review agent reading the diff");
  const res = await runClaude(env, {
    agent: "pr-reviewer",
    label: `${issue.key}-review`,
    cwd: dir,
    prompt: reviewPrompt(issue, diffPath, pr.url),
    maxTurns: cfg.max_turns.review,
    model: cfg.models.review,
    allowedTools: ["Read", "Grep", "Glob"],
  });
  state.update(issue.key, repo.name, { costUsd: res.costUsd ?? 0 });
  const review = parseReview(res.result);
  if (!review) throw new Blocked(`The review agent didn't return a parseable review:\n\n${res.result.slice(-1500)}`);

  step(`posting ${review.comments.length} review comment(s)`);
  await host.postReview(repo, pr, reviewBody(review), review.comments, diff);
  const high = review.comments.filter((c) => c.severity === "high").length;
  await tracker.comment(
    issue.key,
    `**Review posted on [PR #${pr.number}](${pr.url})**: ${review.comments.length} comment(s), ${high} high severity. Waiting for a human to review and merge.`,
  );
  await tracker.updateLabels(issue.key, [LABELS.reviewed]);
  state.update(issue.key, repo.name, {}, { stage: "review", outcome: `${review.comments.length} comments` });
}
