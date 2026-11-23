// Runs one headless Claude Code agent: `claude -p --agent <name>`, with an
// explicit tool allowlist and only the MCP servers this run needs.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./config.js";
import { run } from "./exec.js";
import { log } from "./log.js";

export interface McpNeeds {
  /** Directory for Playwright MCP output (screenshots). Omit for no browser. */
  playwrightOutputDir?: string;
  /** More MCP servers by name, e.g. the ticket tracker's (`Tracker.agentMcpServers`). */
  extraServers?: Record<string, object>;
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

export function mcpConfig(needs: McpNeeds = {}): object {
  const servers: Record<string, object> = {};
  if (needs.playwrightOutputDir) {
    servers.playwright = {
      type: "stdio",
      command: "playwright-mcp",
      args: ["--headless", "--isolated", "--no-sandbox", "--browser", "chromium", "--output-dir", needs.playwrightOutputDir],
    };
  }
  Object.assign(servers, needs.extraServers);
  return { mcpServers: servers };
}

export function claudeArgs(r: ClaudeRun, mcpFile: string): string[] {
  const args = [
    "-p",
    "--agent", r.agent,
    "--output-format", "stream-json", "--verbose",
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
  // The agent user must read its MCP config, but not /data. Only the agent's own MCP
  // credentials (a tracker's MCP server, if any) are in it; it is deleted when the run ends.
  const mcpDir = join(env.workDir, ".agent-runs");
  mkdirSync(mcpDir, { recursive: true });
  const mcpFile = join(mcpDir, `${r.label}-${stamp}.mcp.json`);
  writeFileSync(mcpFile, JSON.stringify(mcpConfig(r.mcp)), { mode: 0o640 });

  // Full event stream (every message and tool call) for this run, written as it happens.
  const transcript = join(runsDir, `${r.label}-${stamp}.jsonl`);
  writeFileSync(transcript, "");
  log.info(`claude ${r.agent} (${r.label}) started; transcript ${transcript}`);

  let final: ResultEvent | undefined;
  let tools = 0;
  const started = Date.now();
  // Prompt via stdin: diffs and tickets can exceed the per-argument size limit.
  const res = await run("claude", claudeArgs(r, mcpFile), {
    cwd: r.cwd,
    input: r.prompt,
    timeoutMs: 90 * 60_000,
    tailChars: 200_000,
    // Runs as the agent user: sudo drops the orchestrator's GitHub and tracker tokens.
    asAgent: true,
    onLine: (line) => {
      appendFileSync(transcript, line + "\n");
      let ev: StreamEvent;
      try {
        ev = JSON.parse(line) as StreamEvent;
      } catch {
        return;
      }
      for (const s of describeEvent(ev)) {
        tools++;
        log.info(`${r.label} › ${s}`);
      }
      if (ev.type === "result") final = ev as ResultEvent;
    },
  });
  rmSync(mcpFile, { force: true });
  if (res.stderr.trim()) appendFileSync(transcript, JSON.stringify({ type: "stderr", text: res.stderr.slice(-5000) }) + "\n");

  const mins = ((Date.now() - started) / 60_000).toFixed(1);
  if (!final) {
    log.warn(`claude ${r.label} exited ${res.code} after ${mins} min without a result`);
    return { ok: false, result: `claude exited ${res.code}: ${res.stderr.slice(-2000)}` };
  }
  const ok = res.code === 0 && !final.is_error && final.subtype === "success";
  const cost = final.total_cost_usd !== undefined ? `$${final.total_cost_usd.toFixed(2)}` : "?";
  log[ok ? "info" : "warn"](`claude ${r.label} ${ok ? "done" : `ended: ${final.subtype}`}: ${mins} min, ${final.num_turns ?? "?"} turns, ${tools} tool calls, ${cost}`);
  return { ok, result: final.result ?? "", costUsd: final.total_cost_usd, turns: final.num_turns, sessionId: final.session_id };
}

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] };
}
interface ResultEvent extends StreamEvent {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
}

/** One short line per tool call in an assistant message, e.g. "Edit src/a.ts". */
export function describeEvent(ev: StreamEvent): string[] {
  if (ev.type !== "assistant") return [];
  return (ev.message?.content ?? [])
    .filter((c) => c.type === "tool_use" && c.name)
    .map((c) => {
      const i = c.input ?? {};
      const arg = i.file_path ?? i.command ?? i.pattern ?? i.url ?? i.skill ?? i.element ?? i.filename ?? i.description ?? "";
      const name = c.name!.replace(/^mcp__playwright__browser_/, "browser ").replace(/^mcp__/, "");
      const s = String(arg).replace(/\s+/g, " ").trim();
      return s ? `${name} ${s.length > 100 ? s.slice(0, 100) + "…" : s}` : name;
    });
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
