// Local memory of what the factory did per ticket. Jira labels are the
// source of truth for "which stage is next"; this file keeps the details
// (PR number, red commit, costs, the step in progress) and survives restarts
// on the /data volume. `status.ts` prints it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.js";

export interface TicketState {
  repo: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  redSha?: string;
  greenSha?: string;
  costUsd?: number;
  lastError?: string;
  /** Stage running now, e.g. "build". Cleared when the stage ends. */
  stage?: string;
  /** Step within the stage, e.g. "installing dependencies". */
  step?: string;
  updatedAt?: string;
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

  all(): Record<string, TicketState> {
    return this.data;
  }

  update(key: string, repo: string, patch: Partial<TicketState>, event?: { stage: string; outcome: string }): TicketState {
    const cur = this.data[key] ?? { repo, history: [] };
    const next: TicketState = { ...cur, ...patch, history: cur.history, updatedAt: new Date().toISOString() };
    if (patch.costUsd !== undefined) next.costUsd = (cur.costUsd ?? 0) + patch.costUsd;
    if (event) next.history = [...cur.history, { at: next.updatedAt!, ...event }];
    this.data[key] = next;
    this.flush();
    return next;
  }

  /** Records and logs the step a stage is on, so `status` and the log show progress. */
  step(key: string, repo: string, stage: string, step: string): void {
    log.info(`${key} [${stage}] ${step}`);
    this.update(key, repo, { stage, step });
  }

  /** Marks the running stage finished (or failed) and records it in history. */
  endStage(key: string, repo: string, stage: string, outcome: string): void {
    this.update(key, repo, { stage: undefined, step: undefined }, { stage, outcome });
  }

  private flush() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
