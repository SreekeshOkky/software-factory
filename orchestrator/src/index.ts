// Poll loop. Each tick, for each repo: close merged PRs, verify Done tickets,
// review open PRs, then build at most one new ticket. Strictly sequential:
// previews share state (one dev server port, one QA dataset).
import { join } from "node:path";
import { LABELS, loadEnv, loadFactoryConfig, type RepoEntry } from "./config.js";
import { GitHub } from "./github.js";
import { Jira, jqlFor, type Issue } from "./jira.js";
import { log } from "./log.js";
import { routeIssue } from "./repo.js";
import { StateStore } from "./state.js";
import { buildStage } from "./stages/build.js";
import { closeStage } from "./stages/close.js";
import { Blocked, block, type Ctx } from "./stages/context.js";
import { reviewStage } from "./stages/review.js";
import { verifyStage } from "./stages/verify.js";
import { mkdirSync } from "node:fs";

type Stage = (ctx: Ctx, repo: RepoEntry, issue: Issue) => Promise<void>;

let stopping = false;

async function runStage(ctx: Ctx, name: string, stage: Stage, repo: RepoEntry, key: string, cleanup: string[] = []) {
  const issue = await ctx.jira.getIssue(key);
  if (routeIssue(ctx.cfg.repos, issue)?.name !== repo.name) return;
  log.info(`${key}: ${name}`);
  try {
    await stage(ctx, repo, issue);
  } catch (e) {
    const reason = e instanceof Blocked ? e.message : `Unexpected error: \`${e instanceof Error ? e.message : String(e)}\``;
    if (!(e instanceof Blocked)) log.error(e);
    // Block on every failure so a broken ticket can't burn tokens in a loop.
    await block(ctx, issue, repo, name, reason, cleanup).catch((err) => log.error("failed to mark blocked", err));
  }
}

export async function tick(ctx: Ctx): Promise<void> {
  for (const repo of ctx.cfg.repos) {
    if (stopping) return;
    const q = jqlFor(ctx.cfg, repo, LABELS);
    try {
      for (const key of await ctx.jira.search(q.toClose)) await runStage(ctx, "close", closeStage, repo, key);
      for (const key of await ctx.jira.search(q.toVerify)) await runStage(ctx, "verify", verifyStage, repo, key);
      for (const key of await ctx.jira.search(q.toReview)) await runStage(ctx, "review", reviewStage, repo, key);
      const [next] = await ctx.jira.search(q.toBuild);
      if (next && !stopping) await runStage(ctx, "build", buildStage, repo, next, [LABELS.building]);
    } catch (e) {
      log.error(`tick failed for ${repo.name}:`, e);
    }
  }
}

async function main() {
  const cfg = loadFactoryConfig();
  const env = loadEnv();
  const tmpDir = join(env.dataDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const ctx: Ctx = {
    cfg,
    env,
    jira: new Jira({ baseUrl: env.jiraBaseUrl, email: env.jiraEmail, token: env.jiraToken, dryRun: env.dryRun }),
    gh: new GitHub({ token: env.ghToken, reviewerToken: env.ghReviewerToken, dryRun: env.dryRun, tmpDir }),
    state: new StateStore(join(env.dataDir, "state.json")),
  };
  log.info(`factory up: ${cfg.repos.map((r) => `${r.name}<-${r.jira.project}`).join(", ")}${env.dryRun ? " (dry run)" : ""}`);

  const once = process.argv.includes("--once");
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log.info(`${sig}: finishing the current stage, then exiting`);
      stopping = true;
    });
  }
  while (!stopping) {
    await tick(ctx);
    if (once) break;
    for (let i = 0; i < cfg.poll_interval_seconds && !stopping; i++) await new Promise((r) => setTimeout(r, 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log.error(e);
    process.exit(1);
  });
}
