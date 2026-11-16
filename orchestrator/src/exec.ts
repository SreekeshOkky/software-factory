// Child-process helpers. Shell commands come from a repo's factory.yml (trusted:
// it is reviewed in the onboarding PR); everything else uses argv, no shell.
import { spawn, type ChildProcess } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** Keep only the last N chars of output (test runs can be huge). */
  tailChars?: number;
}

export function run(cmd: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["pipe", "pipe", "pipe"] });
    collect(child, o, resolve, reject);
  });
}

export function sh(command: string, o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], { cwd: o.cwd, env: { ...process.env, CI: "true", ...o.env }, stdio: ["pipe", "pipe", "pipe"] });
    collect(child, o, resolve, reject);
  });
}

function collect(child: ChildProcess, o: RunOptions, resolve: (r: RunResult) => void, reject: (e: Error) => void) {
  const tail = o.tailChars ?? 2_000_000;
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d: Buffer) => (stdout = (stdout + d.toString()).slice(-tail)));
  child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-tail)));
  const timer = o.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), o.timeoutMs) : undefined;
  child.on("error", reject);
  child.on("close", (code) => {
    if (timer) clearTimeout(timer);
    resolve({ code: code ?? 1, stdout, stderr });
  });
  if (o.input !== undefined) child.stdin!.end(o.input);
  else child.stdin!.end();
}

/** Like run() but throws on a non-zero exit. */
export async function must(cmd: string, args: string[], o: RunOptions = {}): Promise<string> {
  const r = await run(cmd, args, o);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).slice(-2000)}`);
  return r.stdout.trim();
}
