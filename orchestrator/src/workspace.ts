// Per-ticket working copies and the app process. Every stage gets a fresh
// clone so one stage's leftovers can't leak into the next.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { must, run, sh, type RunResult } from "./exec.js";
import { log } from "./log.js";
import type { RepoFactoryYml } from "./repo.js";

export const branchFor = (key: string) => `factory/${key}`;

export async function freshClone(gitUrl: string, dir: string, branch: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await must("git", ["clone", "--branch", branch, gitUrl, dir]);
}

export const git = (dir: string, ...args: string[]) => must("git", args, { cwd: dir });

export async function install(yml: RepoFactoryYml, dir: string): Promise<void> {
  const r = await sh(yml.install, { cwd: dir, timeoutMs: 20 * 60_000, tailChars: 20_000 });
  if (r.code !== 0) throw new Error(`install failed: ${r.stderr.slice(-2000) || r.stdout.slice(-2000)}`);
  // The repo's own Playwright needs browsers for its exact version.
  if (existsSync(join(dir, "node_modules/.bin/playwright"))) {
    await sh("npx --no-install playwright install chromium", { cwd: dir, timeoutMs: 10 * 60_000 });
  }
}

export function runTests(yml: RepoFactoryYml, dir: string): Promise<RunResult> {
  const cmd = yml.check ? `${yml.check} && ${yml.test}` : yml.test;
  return sh(cmd, { cwd: dir, timeoutMs: 30 * 60_000, tailChars: 30_000 });
}

/** Commit that carries the `Factory-Phase: red` trailer, oldest first. */
export async function redCommits(dir: string, base: string): Promise<string[]> {
  const out = await git(dir, "log", "--format=%H", "--reverse", "--grep=^Factory-Phase: red$", `${base}..HEAD`);
  return out.split("\n").filter(Boolean);
}

export async function changedFiles(dir: string, base: string): Promise<string[]> {
  const out = await git(dir, "diff", "--name-only", `${base}...HEAD`);
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

/** Starts factory.yml `start` in its own process group and waits for ready_path. */
export async function startApp(yml: RepoFactoryYml, dir: string): Promise<RunningApp> {
  const child = spawn("bash", ["-lc", yml.start], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(yml.port), HOST: "127.0.0.1", CI: "true" },
  });
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output = (output + d).slice(-5000)));
  child.stderr.on("data", (d: Buffer) => (output = (output + d).slice(-5000)));
  const url = `http://localhost:${yml.port}`;
  const stop = async () => {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 1500));
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* gone */
    }
  };
  const ready = await waitForHttp(url + yml.ready_path, 5 * 60_000);
  if (!ready) {
    await stop();
    throw new Error(`app did not become ready at ${url}${yml.ready_path}:\n${output}`);
  }
  log.info(`app up at ${url}`);
  return { url, stop };
}

export async function hasPlaywrightTest(dir: string): Promise<boolean> {
  const r = await run("node", ["-e", "require.resolve('@playwright/test')"], { cwd: dir });
  return r.code === 0;
}
