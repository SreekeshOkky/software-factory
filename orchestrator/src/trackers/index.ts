// Registry of ticket-tracker vendors. To add one, create src/trackers/<id>/
// exporting a `TrackerVendor`, then add it to VENDORS below. Nothing else in
// the factory needs to change. See docs/adding-a-tracker.md.
import type { FactoryConfig, RepoEntry } from "../config.js";
import { LABELS } from "../labels.js";
import { PerType, vendorEnv } from "../vendor.js";
import { jira } from "./jira/index.js";
import type { Tracker, TrackerVendor } from "./types.js";

export type { Issue, Queue, Tracker, TrackerVendor, VendorInit } from "./types.js";

export const VENDORS: Record<string, TrackerVendor> = {
  [jira.id]: jira,
};

export function vendorFor(type: string): TrackerVendor {
  const v = VENDORS[type];
  if (!v) throw new Error(`unknown tracker type "${type}" (known: ${Object.keys(VENDORS).join(", ")})`);
  return v;
}

/** The trackers the configured repos use, one instance per vendor. */
export class Trackers {
  private all: PerType<Tracker>;

  /** `make` builds the tracker for one `tracker.type`. It is called once per type in use. */
  constructor(private repos: RepoEntry[], make: (type: string) => Tracker) {
    this.all = new PerType(repos.map((r) => r.tracker.type), make);
  }

  for(repo: RepoEntry): Tracker {
    return this.all.get(repo.tracker.type, "tracker");
  }

  /** Which configured repo a ticket from `tracker` belongs to. */
  route(tracker: Tracker, issue: Parameters<Tracker["route"]>[1]): RepoEntry | undefined {
    return tracker.route(this.repos.filter((r) => r.tracker.type === tracker.id), issue);
  }
}

export function createTrackers(cfg: FactoryConfig, dryRun: boolean, source: NodeJS.ProcessEnv = process.env): Trackers {
  return new Trackers(cfg.repos, (type) => {
    const vendor = vendorFor(type);
    return vendor.create({ cfg, labels: LABELS, ...vendorEnv(`the ${vendor.name} tracker`, dryRun, source) });
  });
}
