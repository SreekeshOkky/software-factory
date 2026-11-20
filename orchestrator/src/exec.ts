// Child-process helpers. Shell commands come from a repo's factory.yml (trusted:
// it is reviewed in the onboarding PR); everything else uses argv, no shell.
//
// Trust boundary: anything that runs repo code or model output (Claude, install,
// tests, the app, git inside a workspace) must pass `asAgent: true`. In the
// container that runs it as the unprivileged `agent` user through sudo, which
// resets the environment, so the orchestrator's GitHub and Jira tokens never
// reach it and a different uid can't read them from /proc.
import { spawn, type ChildProcess } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Extra variables. For agent commands these are the ONLY variables passed (besides sudo's env_keep list). */
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  /** Keep only the last N chars of output (test runs can be huge). */
  tailChars?: number;
  /** Called with each complete stdout line as it arrives. */
  onLine?: (line: string) => void;
  /** Run as the unprivileged agent user (see the header comment). */
  asAgent?: boolean;
}

/** The agent user, set by the image. Unset (local dev, unit tests): commands run as the current user. */
export const agentUser = () => process.env.AGENT_USER || undefined;

/** argv for spawning `cmd args` with options applied; exported for tests. */
export function spawnArgs(cmd: string, args: string[], o: RunOptions): { file: string; argv: string[]; env: NodeJS.ProcessEnv } {
  const user = o.asAgent ? agentUser() : undefined;
  if (!user) return { file: cmd, argv: args, env: { ...process.env, ...o.env } };
  const vars = Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${v}`);
  // sudo itself needs the env_keep variables in its own environment; everything else is dropped by env_reset.
  return { file: "sudo", argv: ["-n", "-H", "-u", user, "/usr/local/bin/agent-exec", ...vars, cmd, ...args], env: process.env };
}

export function run(cmd: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const s = spawnArgs(cmd, args, o);
    const child = spawn(s.file, s.argv, { cwd: o.cwd, env: s.env, stdio: ["pipe", "pipe", "pipe"] });
    collect(child, o, resolve, reject);
  });
}

export function sh(command: string, o: RunOptions = {}): Promise<RunResult> {
  return run("bash", ["-lc", command], { ...o, env: { CI: "true", ...o.env } });
}

/** Kills every process of the agent user (the orchestrator's uid can't signal them directly). */
export async function killAgentProcesses(signal: "TERM" | "KILL" = "TERM"): Promise<void> {
  const user = agentUser();
  if (!user) return;
  await new Promise<void>((resolve) => {
    const c = spawn("sudo", ["-n", "-H", "-u", user, "/usr/local/bin/agent-exec", "pkill", `-${signal}`, "-u", user], { stdio: "ignore" });
    c.on("close", () => resolve());
    c.on("error", () => resolve());
  });
}

function collect(child: ChildProcess, o: RunOptions, resolve: (r: RunResult) => void, reject: (e: Error) => void) {
  const tail = o.tailChars ?? 2_000_000;
  let stdout = "";
  let stderr = "";
  let pending = "";
  child.stdout!.on("data", (d: Buffer) => {
    const s = d.toString();
    stdout = (stdout + s).slice(-tail);
    if (!o.onLine) return;
    pending += s;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) o.onLine(l);
  });
  child.stdout!.on("end", () => {
    if (o.onLine && pending.trim()) o.onLine(pending);
  });
  child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-tail)));
  const timer = o.timeoutMs
    ? setTimeout(() => {
        child.kill("SIGKILL");
        if (o.asAgent) void killAgentProcesses("KILL");
      }, o.timeoutMs)
    : undefined;
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
