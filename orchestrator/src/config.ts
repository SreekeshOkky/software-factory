// Factory-wide config (factory.config.yml) and environment. Nothing here is
// specific to one target repo: that lives in each repo's factory.yml (repo.ts).
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { hostVendorFor, inferHostType } from "./hosts/index.js";
import { vendorFor } from "./trackers/index.js";

export { LABELS } from "./labels.js";

/** `tracker: { type: <vendor id>, ...vendor options }`. The vendor validates the options. */
const TrackerRef = z.object({ type: z.string().min(1) }).passthrough();
/** `host: { type: <vendor id>, ...vendor options }`. Optional when the git URL is on a known hostname. */
const HostRef = z.object({ type: z.string().min(1) }, { required_error: "missing `host: { type: ... }`: the git URL isn't on a hostname the factory knows" }).passthrough();

const RepoEntry = z.preprocess(
  // Older configs say `jira: { project, component }`; read that as `tracker: { type: jira, ... }`.
  // `host:` may be left out for github.com and other known hostnames.
  (r) => {
    if (!r || typeof r !== "object") return r;
    let out = r as Record<string, unknown>;
    if ("jira" in out && !("tracker" in out)) {
      const { jira, ...rest } = out;
      out = { ...rest, tracker: { type: "jira", ...(jira as object) } };
    }
    if (!("host" in out) && typeof out.git === "string") {
      const type = inferHostType(out.git);
      if (type) out = { ...out, host: { type } };
    }
    return out;
  },
  z.object({
    name: z.string().regex(/^[a-z0-9-]+$/, "repo name must be kebab-case"),
    git: z.string().min(1),
    base_branch: z.string().default("main"),
    tracker: TrackerRef,
    host: HostRef,
  }),
);

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
    const vendor = vendorFor(r.tracker.type);
    const opts = vendor.repoConfig.safeParse(r.tracker);
    if (!opts.success) throw new Error(`repo ${r.name}: invalid ${vendor.name} tracker config: ${opts.error.message}`);
    const host = hostVendorFor(r.host.type);
    const hostOpts = host.repoConfig.safeParse(r.host);
    if (!hostOpts.success) throw new Error(`repo ${r.name}: invalid ${host.name} host config: ${hostOpts.error.message}`);
  }
  return cfg;
}

export function loadFactoryConfig(path = process.env.FACTORY_CONFIG ?? "/app/factory.config.yml"): FactoryConfig {
  return parseFactoryConfig(readFileSync(path, "utf8"));
}

/** Factory-wide environment. Credentials are read by each vendor (src/trackers/, src/hosts/). */
export interface Env {
  dataDir: string;
  workDir: string;
  dryRun: boolean;
}

export function loadEnv(): Env {
  return {
    dataDir: process.env.DATA_DIR ?? "/data",
    workDir: process.env.WORK_DIR ?? "/work",
    dryRun: process.env.DRY_RUN === "true",
  };
}
