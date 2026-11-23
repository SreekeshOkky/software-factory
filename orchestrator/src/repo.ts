// The contract between the factory and a target repo: factory.yml, written by
// the onboard-repo skill. The factory knows nothing else about a repo.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { parse } from "yaml";
import { z } from "zod";
import type { Issue } from "./trackers/index.js";

const TicketMode = z.object({
  match: z
    .object({
      labels: z.array(z.string()).optional(),
      issue_types: z.array(z.string()).optional(),
    })
    .default({}),
  recipe: z.string().min(1),
});

export const RepoFactoryYmlSchema = z.object({
  install: z.string().min(1),
  check: z.string().optional(),
  test: z.string().min(1),
  start: z.string().min(1),
  port: z.number().int().positive(),
  ready_path: z.string().default("/"),
  navigation_doc: z.string().default("docs/app-navigation.md"),
  protected_paths: z.array(z.string()).default([]),
  commit_style: z
    .object({
      prefixes: z.array(z.string()).default(["feat", "fix", "test", "refactor", "docs"]),
      trailer: z.string().default("Jira: {KEY}"),
    })
    .default({}),
  ticket_modes: z
    .record(TicketMode)
    .refine((m) => "default" in m, { message: "ticket_modes must define a `default` mode" }),
});

export type RepoFactoryYml = z.infer<typeof RepoFactoryYmlSchema>;

export function parseRepoFactoryYml(text: string): RepoFactoryYml {
  return RepoFactoryYmlSchema.parse(parse(text));
}

/** Returns null when the repo hasn't been onboarded. Throws on an invalid file. */
export function loadRepoFactoryYml(repoDir: string): RepoFactoryYml | null {
  const p = join(repoDir, "factory.yml");
  if (!existsSync(p)) return null;
  return parseRepoFactoryYml(readFileSync(p, "utf8"));
}

/** Picks the ticket mode: the first non-default mode whose labels or issue type match. */
export function selectMode(yml: RepoFactoryYml, issue: Pick<Issue, "labels" | "issueType">): { name: string; recipe: string } {
  for (const [name, mode] of Object.entries(yml.ticket_modes)) {
    if (name === "default") continue;
    const byLabel = mode.match.labels?.some((l) => issue.labels.includes(l)) ?? false;
    const byType = mode.match.issue_types?.some((t) => t.toLowerCase() === issue.issueType.toLowerCase()) ?? false;
    if (byLabel || byType) return { name, recipe: mode.recipe };
  }
  return { name: "default", recipe: yml.ticket_modes.default!.recipe };
}

/** Files that match any protected glob. Always includes the factory's own hard limits. */
export function protectedViolations(changed: string[], globs: string[]): string[] {
  const all = [...globs, ".env", ".env.*", "**/.env", "**/.env.*", "factory.yml"];
  return changed.filter((f) => all.some((g) => minimatch(f, g, { dot: true })));
}
