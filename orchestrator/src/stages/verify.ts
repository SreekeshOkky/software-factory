// Done -> verifier checks the acceptance criteria on the merged base branch, in
// a browser, without seeing any code. Optional: regression-test PR on full PASS.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { lastJsonBlock, runClaude } from "../claude.js";
import { LABELS, type RepoEntry } from "../config.js";
import { slugFromGitUrl } from "../github.js";
import type { Issue } from "../trackers/index.js";
import { log } from "../log.js";
import { regressionPrompt, verifyPrompt } from "../prompts.js";
import { loadRepoFactoryYml, type RepoFactoryYml } from "../repo.js";
import { changedFiles, freshClone, git, install, pushBranch, removeDir, runTests, startApp, type RunningApp } from "../workspace.js";
import { Blocked, trackerFor, workDirFor, type Ctx } from "./context.js";

export type Verdict = "PASS" | "FAIL" | "UNTESTABLE";
export interface VerdictRow {
  n: number;
  criterion: string;
  verdict: Verdict;
  evidence: string;
  screenshot?: string;
}

export function parseVerdicts(reply: string): VerdictRow[] | null {
  const j = lastJsonBlock<{ verdicts?: VerdictRow[] }>(reply);
  const rows = j?.verdicts?.filter((v) => v && ["PASS", "FAIL", "UNTESTABLE"].includes(v.verdict));
  return rows?.length ? rows : null;
}

export function verdictTable(rows: VerdictRow[]): string {
  const esc = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");
  return [
    "| # | Criterion | Verdict | Evidence |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.n} | ${esc(r.criterion)} | ${r.verdict === "PASS" ? r.verdict : `**${r.verdict}**`} | ${esc(r.evidence)} |`),
  ].join("\n");
}

export async function verifyStage(ctx: Ctx, repo: RepoEntry, issue: Issue): Promise<void> {
  const { env, cfg, state } = ctx;
  const tracker = trackerFor(ctx, repo);
  const key = issue.key;
  const dir = workDirFor(ctx, repo, key, "verify");
  const shots = `${dir}-shots`;
  await removeDir(shots);
  mkdirSync(shots, { recursive: true });

  const step = (s: string) => state.step(key, repo.name, "verify", s);
  step(`cloning ${repo.base_branch}`);
  await freshClone(repo.git, dir, repo.base_branch);
  const yml = loadRepoFactoryYml(dir);
  if (!yml) throw new Blocked(`\`${repo.name}\` isn't onboarded (no factory.yml), so it can't be verified.`);
  step("installing dependencies");
  await install(yml, dir);
  const nav = existsSync(join(dir, yml.navigation_doc)) ? readFileSync(join(dir, yml.navigation_doc), "utf8") : "";

  step("starting the app");
  const app = await startApp(yml, dir);
  step("verifier agent checking criteria in the browser");
  let rows: VerdictRow[] | null = null;
  let reply = "";
  try {
    // cwd is the empty shots dir, not the clone: the verifier must not see code.
    const res = await runClaude(env, {
      agent: "ticket-verifier",
      label: `${key}-verify`,
      cwd: shots,
      prompt: verifyPrompt(issue, app.url, nav),
      maxTurns: cfg.max_turns.verify,
      model: cfg.models.verify,
      allowedTools: ["mcp__playwright__*"],
      mcp: { playwrightOutputDir: shots },
    });
    state.update(key, repo.name, { costUsd: res.costUsd ?? 0 });
    reply = res.result;
    rows = parseVerdicts(reply);

    if (rows && rows.every((r) => r.verdict === "PASS") && cfg.regression_tests) {
      step("writing regression tests");
      await regression(ctx, repo, issue, yml, dir, app).catch((e) => log.warn(`${key}: regression PR failed: ${e}`));
    }
  } finally {
    await app.stop();
  }
  if (!rows) throw new Blocked(`The verifier didn't return verdicts:\n\n${reply.slice(-1500)}`);

  step("posting verdicts to the ticket");
  const failed = rows.filter((r) => r.verdict !== "PASS");
  const pngs = readdirSync(shots, { recursive: true }).map(String).filter((f) => f.endsWith(".png"));
  await tracker.attach(key, pngs.map((f) => join(shots, f)));
  await tracker.comment(
    key,
    [
      `## Verification on \`${repo.base_branch}\`: ${failed.length ? `${failed.length} of ${rows.length} not passing` : `all ${rows.length} criteria pass`}`,
      "",
      verdictTable(rows),
      "",
      "_Checked in a real browser by an agent that saw only this ticket and the running app._",
      failed.length ? "\nA human decides whether to reopen the ticket or fix the criteria. UNTESTABLE usually means the criterion needs rewording." : "",
    ].join("\n"),
  );
  await tracker.updateLabels(key, [failed.length ? LABELS.verifyFailed : LABELS.verified]);
  state.update(key, repo.name, {}, { stage: "verify", outcome: failed.length ? `${failed.length} not passing` : "all pass" });
}

/** Builder agent writes Playwright regression tests for the verified criteria; factory opens a PR. */
async function regression(ctx: Ctx, repo: RepoEntry, issue: Issue, yml: RepoFactoryYml, dir: string, app: RunningApp) {
  const branch = `factory/${issue.key}-regression`;
  await git(dir, "checkout", "-b", branch);
  const res = await runClaude(ctx.env, {
    agent: "ticket-builder",
    label: `${issue.key}-regression`,
    cwd: dir,
    prompt: regressionPrompt(issue, yml, app.url),
    maxTurns: ctx.cfg.max_turns.build,
    model: ctx.cfg.models.build,
    allowedTools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "mcp__playwright__*"],
    mcp: { playwrightOutputDir: `${dir}-regression-shots` },
  });
  ctx.state.update(issue.key, repo.name, { costUsd: res.costUsd ?? 0 });
  if (!(await changedFiles(dir, repo.base_branch)).length) return;
  if ((await runTests(yml, dir)).code !== 0) throw new Error("regression suite does not pass");
  if (!ctx.env.dryRun) await pushBranch(dir, repo.git, branch);
  const pr = await ctx.gh.createPr(slugFromGitUrl(repo.git), {
    head: branch,
    base: repo.base_branch,
    title: `${issue.key}: regression tests`,
    body: `Playwright regression tests for [${issue.key}](${issue.url}), generated after every acceptance criterion passed verification.\n\n${res.result.slice(-3000)}`,
  });
  await trackerFor(ctx, repo).comment(issue.key, `**Regression tests PR:** [${pr.url}](${pr.url})`);
}
