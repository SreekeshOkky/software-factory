// Runs one headless Claude Code agent: `claude -p --agent <name>`, with an
// explicit tool allowlist and only the MCP servers this run needs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./config.js";
import { run } from "./exec.js";
import { log } from "./log.js";

export interface McpNeeds {
  /** Directory for Playwright MCP output (screenshots). Omit for no browser. */
  playwrightOutputDir?: string;
  /** Give the agent the Atlassian Rovo MCP server (if enabled in env). */
  jira?: boolean;
}

export interface ClaudeRun {
  agent: string;
  prompt: string;
  cwd: string;
  allowedTools: string[];
  maxTurns: number;
  model?: string;
  mcp?: McpNeeds;
  /** Used for the transcript filename, e.g. "PORT-12-build". */
  label: string;
}

export interface ClaudeResult {
  ok: boolean;
  result: string;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
}

export function mcpConfig(env: Env, needs: McpNeeds = {}): object {
  const servers: Record<string, object> = {};
  if (needs.playwrightOutputDir) {
    servers.playwright = {
      type: "stdio",
      command: "mcp-server-playwright",
      args: ["--headless", "--isolated", "--no-sandbox", "--browser", "chromium", "--output-dir", needs.playwrightOutputDir],
    };
  }
  if (needs.jira && env.jiraRovoMcp) {
    servers.atlassian = {
      type: "http",
      url: env.jiraRovoMcpUrl,
      headers: { Authorization: "Basic " + Buffer.from(`${env.jiraEmail}:${env.jiraToken}`).toString("base64") },
    };
  }
  return { mcpServers: servers };
}

export function claudeArgs(r: ClaudeRun, mcpFile: string): string[] {
  const args = [
    "-p",
    "--agent", r.agent,
    "--output-format", "json",
    "--max-turns", String(r.maxTurns),
    "--mcp-config", mcpFile,
    "--strict-mcp-config",
    "--allowedTools", r.allowedTools.join(","),
  ];
  if (r.model) args.push("--model", r.model);
  return args;
}

export async function runClaude(env: Env, r: ClaudeRun): Promise<ClaudeResult> {
  const runsDir = join(env.dataDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const mcpFile = join(runsDir, `${r.label}-${stamp}.mcp.json`);
  // Secrets in the MCP file stay on the data volume only.
  writeFileSync(mcpFile, JSON.stringify(mcpConfig(env, r.mcp)), { mode: 0o600 });

  log.info(`claude ${r.agent} (${r.label}) in ${r.cwd}`);
  // Prompt via stdin: diffs and tickets can exceed the per-argument size limit.
  const res = await run("claude", claudeArgs(r, mcpFile), {
    cwd: r.cwd,
    input: r.prompt,
    timeoutMs: 90 * 60_000,
    // The orchestrator's GitHub/Jira tokens are not passed to agents.
    env: { GH_TOKEN: "", GH_REVIEWER_TOKEN: "", JIRA_API_TOKEN: "", GITHUB_TOKEN: "" },
  });
  writeFileSync(join(runsDir, `${r.label}-${stamp}.json`), res.stdout || res.stderr);

  try {
    const j = JSON.parse(res.stdout) as { is_error?: boolean; result?: string; total_cost_usd?: number; num_turns?: number; session_id?: string; subtype?: string };
    const ok = res.code === 0 && !j.is_error && j.subtype === "success";
    if (!ok) log.warn(`claude ${r.label} ended: ${j.subtype ?? res.code}`);
    return { ok, result: j.result ?? "", costUsd: j.total_cost_usd, turns: j.num_turns, sessionId: j.session_id };
  } catch {
    return { ok: false, result: `claude exited ${res.code}: ${(res.stderr || res.stdout).slice(-2000)}` };
  }
}

/** Extracts the last ```json fenced block from an agent's reply. */
export function lastJsonBlock<T>(text: string): T | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return null;
  try {
    return JSON.parse(last) as T;
  } catch {
    return null;
  }
}
