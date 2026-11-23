import { describe, expect, it } from "vitest";
import { parseFactoryConfig } from "../src/config.js";
import { createTrackers, Trackers, VENDORS, type Issue, type Tracker } from "../src/trackers/index.js";

const base = "statuses: { todo: To Do, in_progress: In Progress, done: Done }\n";

describe("tracker registry", () => {
  it("registers every vendor under its own id, with a config schema", () => {
    for (const [key, v] of Object.entries(VENDORS)) {
      expect(v.id).toBe(key);
      expect(v.id).toMatch(/^[a-z0-9-]+$/);
      expect(typeof v.repoConfig.safeParse).toBe("function");
    }
  });
});

describe("repos[].tracker", () => {
  it("accepts the tracker block", () => {
    const cfg = parseFactoryConfig(`${base}repos: [{ name: a, git: x, tracker: { type: jira, project: P, component: web } }]`);
    expect(cfg.repos[0]!.tracker).toEqual({ type: "jira", project: "P", component: "web" });
  });
  it("still reads the older `jira:` block", () => {
    const cfg = parseFactoryConfig(`${base}repos: [{ name: a, git: x, jira: { project: P } }]`);
    expect(cfg.repos[0]!.tracker).toEqual({ type: "jira", project: "P" });
  });
  it("rejects an unknown tracker type", () => {
    expect(() => parseFactoryConfig(`${base}repos: [{ name: a, git: x, tracker: { type: nope } }]`)).toThrow(/unknown tracker type "nope"/);
  });
  it("rejects options the vendor doesn't accept", () => {
    expect(() => parseFactoryConfig(`${base}repos: [{ name: a, git: x, tracker: { type: jira } }]`)).toThrow(/repo a: invalid Jira Cloud tracker config/);
  });
});

describe("Trackers", () => {
  const fake = (id: string, owns: string): Tracker => ({
    id,
    find: async () => [],
    getIssue: async () => ({}) as Issue,
    route: (repos, issue) => repos.find(() => issue.project === owns),
    transitionTo: async () => true,
    updateLabels: async () => {},
    comment: async () => {},
    attach: async () => {},
    describe: () => id,
  });

  it("only routes a ticket among repos on the same tracker", () => {
    const repos = [
      { name: "a", git: "x", base_branch: "main", tracker: { type: "one" } },
      { name: "b", git: "y", base_branch: "main", tracker: { type: "two" } },
    ];
    const made: string[] = [];
    const t = new Trackers([...repos, { ...repos[0]!, name: "c" }], (type) => (made.push(type), fake(type, "P")));
    expect(t.route(t.for(repos[1]!), { project: "P" } as Issue)?.name).toBe("b");
    expect(made).toEqual(["one", "two"]); // one instance per type
  });

  it("asks only for the env of vendors in use, by name", () => {
    const cfg = parseFactoryConfig(`${base}repos: [{ name: a, git: x, tracker: { type: jira, project: P } }]`);
    expect(() => createTrackers(cfg, true, {})).toThrow("missing env JIRA_BASE_URL (needed by the Jira Cloud tracker)");
    const t = createTrackers(cfg, true, { JIRA_BASE_URL: "https://x/", JIRA_EMAIL: "e", JIRA_API_TOKEN: "t" });
    expect(t.for(cfg.repos[0]!).describe(cfg.repos[0]!)).toBe("jira:P");
    expect(t.for(cfg.repos[0]!).agentMcpServers?.()).toEqual({});
  });
});
