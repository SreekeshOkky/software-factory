// To Do -> In Progress -> (red, green, evidence) -> PR -> In Review.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runClaude } from "../claude.js";
import { LABELS, type RepoEntry } from "../config.js";
import { slugFromGitUrl } from "../github.js";
import type { Issue } from "../jira.js";
import { log } from "../log.js";
import { buildPrompt, evidencePrompt } from "../prompts.js";
import { agentStatus, checkRedGreen, section } from "../redgreen.js";
import { loadRepoFactoryYml, protectedViolations, selectMode } from "../repo.js";
import { branchFor, changedFiles, freshClone, git, install, pushBranch, redCommits, removeDir, runTests, startApp } from "../workspace.js";
import { Blocked, workDirFor, type Ctx } from "./context.js";

export async function buildStage(ctx: Ctx, repo: RepoEntry, issue: Issue): Promise<void> {
  const { jira, gh, cfg, env, state } = ctx;
  const key = issue.key;
  const branch = branchFor(key);
  const slug = slugFromGitUrl(repo.git);

  const step = (s: string) => state.step(key, repo.name, "build", s);
  await jira.updateLabels(key, [LABELS.building]);
  await jira.transitionTo(key, cfg.statuses.in_progress);
  state.update(key, repo.name, { branch }, { stage: "build", outcome: "started" });
  await jira.comment(
    key,
    `**Factory started building** on branch \`${branch}\`. It will write failing tests first, then the implementation, then open a PR. Labels on this ticket show the current stage.`,
  );

  const dir = workDirFor(ctx, repo, key, "build");
  const evidenceDir = `${dir}-evidence`;
  await removeDir(evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });

  step(`cloning ${repo.base_branch}`);
  await freshClone(repo.git, dir, repo.base_branch);
  const yml = loadRepoFactoryYml(dir);
  if (!yml) throw new Blocked(`\`${repo.name}\` has no factory.yml on \`${repo.base_branch}\`, so it isn't onboarded. Run the onboard-repo skill on it first.`);
  await git(dir, "checkout", "-b", branch);
  step("installing dependencies");
  await install(yml, dir);

  // 1. Build: red, green, refactor.
  const mode = selectMode(yml, issue);
  step(`builder agent working (mode "${mode.name}")`);
  const built = await runClaude(env, {
    agent: "ticket-builder",
    label: `${key}-build`,
    cwd: dir,
    prompt: buildPrompt(issue, yml, mode, repo.base_branch),
    maxTurns: cfg.max_turns.build,
    model: cfg.models.build,
    allowedTools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "Skill", "mcp__atlassian__*", "mcp__playwright__*"],
    mcp: { jira: true, playwrightOutputDir: join(evidenceDir, "builder") },
  });
  state.update(key, repo.name, { costUsd: built.costUsd ?? 0 });
  const status = agentStatus(built.result);
  if (status.status === "BLOCKED") throw new Blocked(`The builder stopped:\n\n${status.reason}`);
  if (!built.ok && status.status !== "DONE") throw new Blocked(`The builder run didn't finish:\n\n${built.result.slice(-2000)}`);

  // 2. The factory's own checks: protected paths, then red-green.
  step("checking protected paths");
  const changed = await changedFiles(dir, repo.base_branch);
  if (!changed.length) throw new Blocked("The builder made no commits.");
  const bad = protectedViolations(changed, yml.protected_paths);
  if (bad.length) throw new Blocked(`The change touches protected paths: ${bad.map((f) => `\`${f}\``).join(", ")}. A human has to make that change.`);

  const rg = await checkRedGreen({
    redCommits: () => redCommits(dir, repo.base_branch),
    head: () => git(dir, "rev-parse", "HEAD"),
    checkout: async (ref) => {
      step(`red-green check: testing at ${ref.slice(0, 8)}`);
      await git(dir, "checkout", "--quiet", ref);
    },
    install: () => install(yml, dir),
    test: async () => {
      const r = await runTests(yml, dir);
      return { code: r.code, output: r.stdout + r.stderr };
    },
  });
  if (!rg.ok) throw new Blocked(`Red-green check failed: ${rg.reason}`);
  await git(dir, "checkout", "--quiet", branch);
  state.update(key, repo.name, { redSha: rg.red, greenSha: rg.green }, { stage: "build", outcome: "red-green verified" });
  // Tests written in the red commit and then changed later weaken the red proof. Not a block, but a human should look.
  const redFiles = (await git(dir, "show", "--name-only", "--format=", rg.red)).split("\n").filter(Boolean);
  const laterChanged = new Set((await git(dir, "diff", "--name-only", rg.red, rg.green)).split("\n"));
  const testsEdited = redFiles.filter((f) => laterChanged.has(f));
  if (testsEdited.length) log.warn(`${key}: tests from the red commit changed afterwards: ${testsEdited.join(", ")}`);
  const editedNote = testsEdited.length
    ? `**Check this:** tests from the red commit were changed after it: ${testsEdited.map((f) => `\`${f}\``).join(", ")}. Compare with \`git diff ${rg.red.slice(0, 8)} ${rg.green.slice(0, 8)} -- ${testsEdited.join(" ")}\` to make sure no assertion was weakened.`
    : "";

  // 3. Evidence: start the app and screenshot each criterion.
  // Playwright MCP writes named screenshots relative to the agent's cwd, so run
  // the agent from inside the shots dir.
  const shotsDir = join(evidenceDir, "shots");
  mkdirSync(shotsDir, { recursive: true });
  step("starting the app for screenshots");
  const app = await startApp(yml, dir);
  step("evidence agent taking screenshots");
  let evidenceList = "";
  try {
    const nav = existsSync(join(dir, yml.navigation_doc)) ? readFileSync(join(dir, yml.navigation_doc), "utf8") : "";
    const ev = await runClaude(env, {
      agent: "evidence-capture",
      label: `${key}-evidence`,
      cwd: shotsDir,
      prompt: evidencePrompt(issue, app.url, nav),
      maxTurns: cfg.max_turns.evidence,
      model: cfg.models.verify,
      allowedTools: ["mcp__playwright__*"],
      mcp: { playwrightOutputDir: shotsDir },
    });
    state.update(key, repo.name, { costUsd: ev.costUsd ?? 0 });
    evidenceList = ev.result;
  } finally {
    await app.stop();
  }

  const pngs = existsSync(shotsDir) ? readdirSync(shotsDir, { recursive: true }).map(String).filter((f) => f.endsWith(".png")) : [];
  const evidenceRel = `.factory/evidence/${key}`;
  if (pngs.length) {
    mkdirSync(join(dir, evidenceRel), { recursive: true });
    for (const f of pngs) copyFileSync(join(shotsDir, f), join(dir, evidenceRel, f.split("/").pop()!));
    await git(dir, "add", evidenceRel);
    await git(dir, "commit", "-m", `docs: add screenshots for ${key}`, "-m", `Factory-Phase: evidence\n${yml.commit_style.trailer.replace("{KEY}", key)}`);
  }

  // 4. Push and open the PR.
  step("pushing and opening the PR");
  if (!env.dryRun) await pushBranch(dir, repo.git, branch);
  const names = pngs.map((f) => f.split("/").pop()!);
  const imgs = names.map((n) => `![${n}](https://github.com/${slug}/blob/${branch}/${evidenceRel}/${n}?raw=true)`).join("\n");
  const body = [
    `Implements [${key}](${issue.url}): ${issue.summary}`,
    "",
    "## Summary",
    section(built.result, "Summary") || "(builder gave no summary)",
    "",
    "## Acceptance criteria",
    section(built.result, "Acceptance criteria") || "(builder gave no table)",
    "",
    "## Red-green (checked by the factory)",
    `- Red: \`${rg.red.slice(0, 8)}\` - test suite **failed** as expected`,
    `- Green: \`${rg.green.slice(0, 8)}\` - full test suite **passed**`,
    `- Mode: \`${mode.name}\``,
    editedNote ? `\n> ${editedNote}` : "",
    "",
    "## Screenshots",
    imgs || "_No screenshots captured._",
    evidenceList ? `\n<details><summary>What each screenshot shows</summary>\n\n${evidenceList}\n</details>` : "",
    "",
    "---",
    "Opened by the software factory. A review agent will comment; a human merges.",
  ].join("\n");
  const pr = await gh.createPr(slug, { head: branch, base: repo.base_branch, title: `${key}: ${issue.summary}`, body });
  state.update(key, repo.name, { prNumber: pr.number, prUrl: pr.url }, { stage: "build", outcome: `PR ${pr.url}` });

  // 5. Jira: screenshots, comment, status, labels.
  step("updating Jira");
  await jira.attach(key, pngs.map((f) => join(shotsDir, f)));
  await jira.comment(
    key,
    [
      `**PR opened:** [${pr.url}](${pr.url})`,
      "",
      section(built.result, "Summary"),
      "",
      `Red-green verified by the factory (red \`${rg.red.slice(0, 8)}\`, green \`${rg.green.slice(0, 8)}\`). ${pngs.length} screenshot(s) attached.`,
      editedNote,
    ].join("\n"),
  );
  if (cfg.statuses.review) await jira.transitionTo(key, cfg.statuses.review);
  await jira.updateLabels(key, [LABELS.prOpen], [LABELS.building]);
  log.info(`${key}: PR ${pr.url}`);
}
