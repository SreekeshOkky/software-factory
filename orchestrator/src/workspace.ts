// Per-ticket working copies and the app process. Every stage gets a fresh
// clone so one stage's leftovers can't leak into the next.
//
// Ownership: the factory (which holds the code host's token) clones from the host
// into `<dir>.src`; the agent user then clones that into `<dir>` and owns it.
// Everything inside `<dir>` (install, tests, app, git) runs as the agent, so
// code or git config the agent writes never runs with the factory's tokens.
// To push, the factory fetches the branch into its own fresh repo and pushes
// from there, never from the agent's repo.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentUser, killAgentProcesses, must, run, sh, spawnArgs, type RunResult } from "./exec.js";
import { log } from "./log.js";
import type { GitRemote } from "./hosts/index.js";
import type { RepoFactoryYml } from "./repo.js";

export const branchFor = (key: string) => `factory/${key}`;

/** Removes a directory whether the factory or the agent created it. */
export async function removeDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* agent-owned files the factory can't delete */
  }
  if (existsSync(dir) && agentUser()) await run("rm", ["-rf", dir], { asAgent: true });
  if (existsSync(dir)) throw new Error(`could not remove ${dir}`);
}

export async function freshClone(remote: GitRemote, dir: string, branch: string): Promise<void> {
  const src = `${dir}.src`;
  await removeDir(dir);
  await removeDir(src);
  mkdirSync(join(dir, ".."), { recursive: true });
  // Factory clone over the network (needs the token); agent clone from it (no token).
  await must("git", ["clone", "--quiet", "--branch", branch, remote.url, src], { env: remote.env });
  await must("git", ["clone", "--quiet", "--no-hardlinks", "--branch", branch, src, dir], { asAgent: true });
  // The agent clone's `origin/<branch>` now names the base commit the stages diff against.
  await removeDir(src);
}

/** git inside an agent workspace, as the agent. */
export const git = (dir: string, ...args: string[]) => must("git", args, { cwd: dir, asAgent: true });

/**
 * Pushes `branch` from an agent workspace without running git in it as the
 * factory: fetch into a fresh factory-owned repo, push from there. Only
 * `factory/*` branches are ever pushed, so a force push is safe.
 */
export async function pushBranch(agentDir: string, remote: GitRemote, branch: string): Promise<void> {
  if (!branch.startsWith("factory/")) throw new Error(`refusing to push non-factory branch ${branch}`);
  const tmp = `${agentDir}.push`;
  const bundle = `${agentDir}.bundle`;
  await removeDir(tmp);
  await removeDir(bundle);
  // The agent exports the branch as a bundle: a plain file, so the factory never
  // opens the agent's repository (its hooks and config stay untouched).
  await git(agentDir, "bundle", "create", "--quiet", bundle, `refs/heads/${branch}`);
  await must("git", ["init", "--quiet", tmp]);
  await must("git", ["-C", tmp, "fetch", "--quiet", "--no-tags", bundle, `+refs/heads/${branch}:refs/heads/${branch}`]);
  await must("git", ["-C", tmp, "push", "--quiet", "--force", remote.url, `refs/heads/${branch}:refs/heads/${branch}`], { env: remote.env });
  await removeDir(tmp);
  await removeDir(bundle);
}

export async function install(yml: RepoFactoryYml, dir: string): Promise<void> {
  const r = await sh(yml.install, { cwd: dir, timeoutMs: 20 * 60_000, tailChars: 20_000, asAgent: true });
  if (r.code !== 0) throw new Error(`install failed: ${r.stderr.slice(-2000) || r.stdout.slice(-2000)}`);
  // The repo's own Playwright needs browsers for its exact version.
  if (existsSync(join(dir, "node_modules/.bin/playwright"))) {
    await sh("npx --no-install playwright install chromium", { cwd: dir, timeoutMs: 10 * 60_000, asAgent: true });
  }
}

export function runTests(yml: RepoFactoryYml, dir: string): Promise<RunResult> {
  const cmd = yml.check ? `${yml.check} && ${yml.test}` : yml.test;
  return sh(cmd, { cwd: dir, timeoutMs: 30 * 60_000, tailChars: 30_000, asAgent: true });
}

/** Commit that carries the `Factory-Phase: red` trailer, oldest first. */
export async function redCommits(dir: string, base: string): Promise<string[]> {
  const out = await git(dir, "log", "--format=%H", "--reverse", "--grep=^Factory-Phase: red$", `origin/${base}..HEAD`);
  return out.split("\n").filter(Boolean);
}

export async function changedFiles(dir: string, base: string): Promise<string[]> {
  const out = await git(dir, "diff", "--name-only", `origin/${base}...HEAD`);
  return out.split("\n").filter(Boolean);
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export interface RunningApp {
  url: string;
  stop(): Promise<void>;
}

/** Starts factory.yml `start` as the agent, in its own process group, and waits for ready_path. */
export async function startApp(yml: RepoFactoryYml, dir: string): Promise<RunningApp> {
  const s = spawnArgs("bash", ["-lc", yml.start], { asAgent: true, env: { PORT: String(yml.port), HOST: "127.0.0.1", CI: "true" } });
  const child = spawn(s.file, s.argv, { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: s.env });
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output = (output + d).slice(-5000)));
  child.stderr.on("data", (d: Buffer) => (output = (output + d).slice(-5000)));
  const url = `http://localhost:${yml.port}`;
  const stop = async () => {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      /* already gone, or owned by the agent user */
    }
    // Stages run one at a time and no agent is running while the app stops, so this only hits the app.
    await killAgentProcesses("TERM");
    await new Promise((r) => setTimeout(r, 1500));
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* gone */
    }
    await killAgentProcesses("KILL");
  };
  const ready = await waitForHttp(url + yml.ready_path, 5 * 60_000);
  if (!ready) {
    await stop();
    throw new Error(`app did not become ready at ${url}${yml.ready_path}:\n${output}`);
  }
  log.info(`app up at ${url}`);
  return { url, stop };
}
