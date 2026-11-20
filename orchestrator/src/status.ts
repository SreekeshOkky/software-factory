// `node dist/status.js [KEY]`: one line per ticket (stage, step, age, cost, PR),
// or the full history of one ticket. Reads only /data/state.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TicketState } from "./state.js";

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function statusRows(data: Record<string, TicketState>, now = Date.now()): string[][] {
  return Object.entries(data)
    .sort(([, a], [, b]) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .map(([key, t]) => {
      const last = t.history.at(-1);
      const where = t.stage ? `${t.stage}: ${t.step ?? "…"}` : last ? `${last.stage}: ${last.outcome}` : "-";
      return [key, t.stage ? "RUNNING" : last?.outcome === "blocked" ? "BLOCKED" : "idle", where, ago(t.updatedAt ?? last?.at, now), t.costUsd ? `$${t.costUsd.toFixed(2)}` : "-", t.prUrl ?? "-"];
    });
}

export function table(rows: string[][]): string {
  const head = ["TICKET", "STATE", "STAGE / STEP", "UPDATED", "COST", "PR"];
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.min(70, Math.max(...all.map((r) => (r[i] ?? "").length))));
  return all.map((r) => r.map((c, i) => (c.length > w[i]! ? c.slice(0, w[i]! - 1) + "…" : c.padEnd(w[i]!))).join("  ").trimEnd()).join("\n");
}

function main() {
  const path = join(process.env.DATA_DIR ?? "/data", "state.json");
  if (!existsSync(path)) return console.log("No tickets yet.");
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, TicketState>;
  const key = process.argv[2];
  if (!key) return console.log(table(statusRows(data)));
  const t = data[key];
  if (!t) return console.log(`${key}: not seen by the factory`);
  console.log(`${key} (${t.repo})${t.stage ? ` RUNNING ${t.stage}: ${t.step}` : ""}`);
  if (t.prUrl) console.log(`PR: ${t.prUrl}`);
  if (t.redSha) console.log(`red ${t.redSha.slice(0, 8)}  green ${t.greenSha?.slice(0, 8)}`);
  if (t.costUsd) console.log(`cost: $${t.costUsd.toFixed(2)}`);
  if (t.lastError) console.log(`last error: ${t.lastError.split("\n")[0]}`);
  for (const h of t.history) console.log(`  ${h.at}  ${h.stage.padEnd(7)} ${h.outcome}`);
  console.log(`transcripts: ls ${join(process.env.DATA_DIR ?? "/data", "runs")}/${key}-*`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
