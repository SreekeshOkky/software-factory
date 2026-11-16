import { join } from "node:path";
import type { Env, FactoryConfig, RepoEntry } from "../config.js";
import { LABELS } from "../config.js";
import type { GitHub } from "../github.js";
import type { Issue, Jira } from "../jira.js";
import { log } from "../log.js";
import type { StateStore } from "../state.js";

export interface Ctx {
  cfg: FactoryConfig;
  env: Env;
  jira: Jira;
  gh: GitHub;
  state: StateStore;
}

export const workDirFor = (ctx: Ctx, repo: RepoEntry, key: string, stage: string) => join(ctx.env.workDir, repo.name, `${key}-${stage}`);

/** Thrown for expected stops (not onboarded, red didn't fail, ...): blocks the ticket with a clear reason. */
export class Blocked extends Error {}

/** Marks a ticket blocked with a Jira comment, so a human sees why. */
export async function block(ctx: Ctx, issue: Issue, repo: RepoEntry, stage: string, reason: string, removeLabels: string[] = []) {
  log.warn(`${issue.key} blocked in ${stage}: ${reason}`);
  ctx.state.update(issue.key, repo.name, { lastError: reason }, { stage, outcome: "blocked" });
  await ctx.jira.comment(
    issue.key,
    `**Factory stopped (${stage})**\n\n${reason}\n\nFix the cause, remove the \`${LABELS.blocked}\` label, and the factory will pick the ticket up again.`,
  );
  await ctx.jira.updateLabels(issue.key, [LABELS.blocked], removeLabels);
}
