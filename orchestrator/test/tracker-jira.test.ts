import { describe, expect, it } from "vitest";
import { LABELS, parseFactoryConfig } from "../src/config.js";
import { Jira, jqlFor, mdToWiki } from "../src/trackers/jira/index.js";

const cfg = parseFactoryConfig(`
statuses: { todo: To Do, in_progress: In Progress, review: In Review, done: Done }
repos: [{ name: portfolio, git: "git@github.com:o/p.git", jira: { project: PORT, component: web } }]
`);

describe("jqlFor", () => {
  const q = jqlFor(cfg, cfg.repos[0]!, LABELS);
  it("scopes every query to project, component and the opt-in label", () => {
    for (const jql of Object.values(q)) {
      expect(jql).toContain('project = "PORT"');
      expect(jql).toContain('component = "web"');
      expect(jql).toContain('labels = "factory-enabled"');
      expect(jql).toContain('"factory-blocked"');
    }
  });
  it("never rebuilds a ticket that is building or has a PR", () => {
    expect(q.toBuild).toContain('status = "To Do"');
    expect(q.toBuild).toMatch(/labels not in \("factory-building", "factory-pr-open"/);
  });
  it("verifies Done tickets once", () => {
    expect(q.toVerify).toContain('status = "Done"');
    expect(q.toVerify).toContain('"factory-verified", "factory-verify-failed"');
  });
});

describe("mdToWiki", () => {
  it("converts tables, code, links and headings", () => {
    const md = "## Result\n\n| A | B |\n| --- | --- |\n| `x` | **y** |\n\n[PR](https://x/1)\n```ts\nconst a = 1;\n```";
    expect(mdToWiki(md)).toBe("h2. Result\n\n||A||B||\n|{{x}}|*y*|\n\n[PR|https://x/1]\n{code:ts}\nconst a = 1;\n{code}");
  });
  it("converts bullets", () => {
    expect(mdToWiki("- a\n  - b")).toBe("* a\n** b");
  });
});

describe("Jira client", () => {
  function client(responses: Record<string, unknown>, calls: { method: string; url: string; body?: unknown }[], dryRun = false) {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const key = `${init.method} ${new URL(url).pathname}`;
      const body = responses[key];
      return new Response(body === undefined ? null : JSON.stringify(body), { status: body === undefined ? 204 : 200 });
    }) as unknown as typeof fetch;
    return new Jira({ baseUrl: "https://x.atlassian.net", email: "e", token: "t", fetchImpl, dryRun });
  }

  it("transitions by target status name", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const j = client({ "GET /rest/api/2/issue/P-1/transitions": { transitions: [{ id: "31", name: "Start", to: { name: "In Progress" } }] } }, calls);
    expect(await j.transitionTo("P-1", "in progress")).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { transition: { id: "31" } } });
    expect(await j.transitionTo("P-1", "Done")).toBe(false);
  });

  it("paginates search", async () => {
    let page = 0;
    const fetchImpl = (async () =>
      new Response(JSON.stringify(page++ === 0 ? { issues: [{ key: "P-1" }], nextPageToken: "n" } : { issues: [{ key: "P-2" }] }))) as unknown as typeof fetch;
    const j = new Jira({ baseUrl: "https://x", email: "e", token: "t", fetchImpl });
    expect(await j.search("x")).toEqual(["P-1", "P-2"]);
  });

  it("does not write in dry-run", async () => {
    const calls: { method: string; url: string }[] = [];
    const j = client({}, calls, true);
    await j.comment("P-1", "hi");
    await j.updateLabels("P-1", ["a"]);
    expect(calls).toEqual([]);
  });
});
