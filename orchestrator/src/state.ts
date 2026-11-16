// Local memory of what the factory did per ticket. Jira labels are the
// source of truth for "which stage is next"; this file keeps the details
// (PR number, red commit, costs) and survives restarts on the /data volume.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TicketState {
  repo: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  redSha?: string;
  greenSha?: string;
  costUsd?: number;
  lastError?: string;
  history: { at: string; stage: string; outcome: string }[];
}

export class StateStore {
  private data: Record<string, TicketState> = {};
  constructor(private path: string) {
    if (existsSync(path)) this.data = JSON.parse(readFileSync(path, "utf8"));
  }

  get(key: string): TicketState | undefined {
    return this.data[key];
  }

  update(key: string, repo: string, patch: Partial<TicketState>, event?: { stage: string; outcome: string }): TicketState {
    const cur = this.data[key] ?? { repo, history: [] };
    const next: TicketState = { ...cur, ...patch, history: cur.history };
    if (patch.costUsd !== undefined) next.costUsd = (cur.costUsd ?? 0) + patch.costUsd;
    if (event) next.history = [...cur.history, { at: new Date().toISOString(), ...event }];
    this.data[key] = next;
    this.flush();
    return next;
  }

  private flush() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
