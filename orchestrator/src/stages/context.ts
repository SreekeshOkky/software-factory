import { join } from "node:path";
import type { Env, FactoryConfig, RepoEntry } from "../config.js";
import { LABELS } from "../config.js";
import type { GitHub } from "../github.js";
import type { Issue, Tracker, Trackers } from "../trackers/index.js";
import { log } from "../log.js";
import type { StateStore } from "../state.js";

export interface Ctx {
  cfg: FactoryConfig;
  env: Env;
  trackers: Trackers;
  gh: GitHub;
  state: StateStore;
}

/** The tracker a repo's tickets live in. */
export const trackerFor = (ctx: Ctx, repo: RepoEntry): Tracker => ctx.trackers.for(repo);

export const workDirFor = (ctx: Ctx, repo: RepoEntry, key: string, stage: string) => join(ctx.env.workDir, repo.name, `${key}-${stage}`);

/** Thrown for expected stops (not onboarded, red didn't fail, ...): blocks the ticket with a clear reason. */
export class Blocked extends Error {}

/** How to retry a blocked stage. A build only starts from the To Do status, and it has already moved the ticket on. */
export function retryHint(stage: string, todoStatus: string): string {
  const label = `remove the \`${LABELS.blocked}\` label`;
  if (stage === "build") return `Fix the cause, move the ticket back to **${todoStatus}**, and ${label}. The factory will build it again.`;
  return `Fix the cause and ${label}, and the factory will retry this stage.`;
}

/** Marks a ticket blocked with a tracker comment, so a human sees why. */
export async function block(ctx: Ctx, issue: Issue, repo: RepoEntry, stage: string, reason: string, removeLabels: string[] = []) {
  log.warn(`${issue.key} blocked in ${stage}: ${reason}`);
  ctx.state.update(issue.key, repo.name, { lastError: reason }, { stage, outcome: "blocked" });
  const tracker = trackerFor(ctx, repo);
  await tracker.comment(issue.key, `**Factory stopped (${stage})**\n\n${reason}\n\n${retryHint(stage, ctx.cfg.statuses.todo)}`);
  await tracker.updateLabels(issue.key, [LABELS.blocked], removeLabels);
}
