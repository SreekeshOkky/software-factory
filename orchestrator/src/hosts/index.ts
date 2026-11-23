// Registry of code-host vendors. To add one, create src/hosts/<id>/ exporting
// a `CodeHostVendor`, then add it to VENDORS below. Nothing else in the factory
// needs to change. See docs/adding-a-code-host.md.
import type { FactoryConfig, RepoEntry } from "../config.js";
import { PerType, vendorEnv } from "../vendor.js";
import { gitHostname } from "./git.js";
import { github } from "./github/index.js";
import type { CodeHost, CodeHostVendor } from "./types.js";

export type { CodeHost, CodeHostVendor, GitRemote, HostInit, PrInfo, ReviewComment } from "./types.js";

export const VENDORS: Record<string, CodeHostVendor> = {
  [github.id]: github,
};

export function hostVendorFor(type: string): CodeHostVendor {
  const v = VENDORS[type];
  if (!v) throw new Error(`unknown code host type "${type}" (known: ${Object.keys(VENDORS).join(", ")})`);
  return v;
}

/** The host type for a git URL on a well-known hostname, e.g. github.com -> "github". */
export function inferHostType(gitUrl: string): string | undefined {
  const h = gitHostname(gitUrl);
  return Object.values(VENDORS).find((v) => h && v.hostnames.includes(h))?.id;
}

/** The code hosts the configured repos use, one instance per vendor. */
export class CodeHosts {
  private all: PerType<CodeHost>;

  /** `make` builds the host for one `host.type`. It is called once per type in use. */
  constructor(repos: RepoEntry[], make: (type: string) => CodeHost) {
    this.all = new PerType(repos.map((r) => r.host.type), make);
  }

  for(repo: RepoEntry): CodeHost {
    return this.all.get(repo.host.type, "code host");
  }
}

export function createCodeHosts(cfg: FactoryConfig, dryRun: boolean, tmpDir: string, source: NodeJS.ProcessEnv = process.env): CodeHosts {
  return new CodeHosts(cfg.repos, (type) => {
    const vendor = hostVendorFor(type);
    return vendor.create({ tmpDir, ...vendorEnv(`the ${vendor.name} code host`, dryRun, source) });
  });
}
