// Factory-wide config (factory.config.yml) and environment. Nothing here is
// specific to one target repo: that lives in each repo's factory.yml (repo.ts).
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const RepoEntry = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "repo name must be kebab-case"),
  git: z.string().min(1),
  base_branch: z.string().default("main"),
  jira: z.object({
    project: z.string().min(1),
    component: z.string().optional(),
  }),
});

export const FactoryConfigSchema = z.object({
  poll_interval_seconds: z.number().int().positive().default(60),
  statuses: z.object({
    todo: z.string(),
    in_progress: z.string(),
    review: z.string().optional(),
    done: z.string(),
  }),
  enable_label: z.string().default("factory-enabled"),
  max_turns: z
    .object({
      build: z.number().int().positive().default(150),
      evidence: z.number().int().positive().default(40),
      review: z.number().int().positive().default(40),
      verify: z.number().int().positive().default(60),
    })
    .default({}),
  models: z
    .object({
      build: z.string().default("opus"),
      review: z.string().default("opus"),
      verify: z.string().default("sonnet"),
    })
    .default({}),
  regression_tests: z.boolean().default(false),
  repos: z.array(RepoEntry).min(1),
});

export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;
export type RepoEntry = z.infer<typeof RepoEntry>;

export function parseFactoryConfig(text: string): FactoryConfig {
  const cfg = FactoryConfigSchema.parse(parse(text));
  const names = new Set<string>();
  for (const r of cfg.repos) {
    if (names.has(r.name)) throw new Error(`duplicate repo name: ${r.name}`);
    names.add(r.name);
  }
  return cfg;
}

export function loadFactoryConfig(path = process.env.FACTORY_CONFIG ?? "/app/factory.config.yml"): FactoryConfig {
  return parseFactoryConfig(readFileSync(path, "utf8"));
}

export interface Env {
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraToken: string;
  jiraRovoMcp: boolean;
  jiraRovoMcpUrl: string;
  ghToken: string;
  ghReviewerToken: string;
  dataDir: string;
  workDir: string;
  dryRun: boolean;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function loadEnv(): Env {
  const ghToken = req("GH_TOKEN");
  return {
    jiraBaseUrl: req("JIRA_BASE_URL").replace(/\/+$/, ""),
    jiraEmail: req("JIRA_EMAIL"),
    jiraToken: req("JIRA_API_TOKEN"),
    jiraRovoMcp: process.env.JIRA_ROVO_MCP === "true",
    jiraRovoMcpUrl: process.env.JIRA_ROVO_MCP_URL ?? "https://mcp.atlassian.com/v1/mcp",
    ghToken,
    ghReviewerToken: process.env.GH_REVIEWER_TOKEN || ghToken,
    dataDir: process.env.DATA_DIR ?? "/data",
    workDir: process.env.WORK_DIR ?? "/work",
    dryRun: process.env.DRY_RUN === "true",
  };
}

/** Labels the factory uses to mark progress on a ticket. Jira-safe (no spaces). */
export const LABELS = {
  building: "factory-building",
  prOpen: "factory-pr-open",
  reviewed: "factory-reviewed",
  merged: "factory-merged",
  blocked: "factory-blocked",
  verified: "factory-verified",
  verifyFailed: "factory-verify-failed",
} as const;
