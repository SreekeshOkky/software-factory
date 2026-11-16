// PR merged by a human -> ticket to Done. PR closed without merge -> blocked.
import { LABELS, type RepoEntry } from "../config.js";
import { slugFromGitUrl } from "../github.js";
import type { Issue } from "../jira.js";
import { branchFor } from "../workspace.js";
import { Blocked, type Ctx } from "./context.js";

export async function closeStage(ctx: Ctx, repo: RepoEntry, issue: Issue): Promise<void> {
  const pr = await ctx.gh.findPr(slugFromGitUrl(repo.git), branchFor(issue.key));
  if (!pr || pr.state === "OPEN") return;
  if (pr.state === "CLOSED") {
    throw new Blocked(`[PR #${pr.number}](${pr.url}) was closed without merging.`);
  }
  const moved = await ctx.jira.transitionTo(issue.key, ctx.cfg.statuses.done);
  if (!moved) throw new Blocked(`PR merged, but the workflow has no transition from "${issue.status}" to "${ctx.cfg.statuses.done}".`);
  await ctx.jira.comment(issue.key, `[PR #${pr.number}](${pr.url}) merged. Moved to ${ctx.cfg.statuses.done}; verification runs next.`);
  await ctx.jira.updateLabels(issue.key, [LABELS.merged]);
  ctx.state.update(issue.key, repo.name, {}, { stage: "close", outcome: "merged" });
}
