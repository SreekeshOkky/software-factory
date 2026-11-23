import { describe, expect, it } from "vitest";
import { parseFactoryConfig } from "../src/config.js";
import { parseRepoFactoryYml, protectedViolations, selectMode } from "../src/repo.js";
import { Jira } from "../src/trackers/jira/index.js";

const yml = parseRepoFactoryYml(`
install: npm ci
check: npm run check
test: npm test
start: npm run preview
port: 4321
protected_paths: ["vercel.json", "public/*.txt"]
ticket_modes:
  default:
    recipe: one failing test per criterion
  content:
    match: { labels: [content], issue_types: [Blog] }
    recipe: assert the post page exists
`);

describe("factory.yml", () => {
  it("applies defaults", () => {
    expect(yml.ready_path).toBe("/");
    expect(yml.navigation_doc).toBe("docs/app-navigation.md");
    expect(yml.commit_style.trailer).toBe("Jira: {KEY}");
  });

  it("requires a default ticket mode", () => {
    expect(() => parseRepoFactoryYml("install: a\ntest: b\nstart: c\nport: 1\nticket_modes:\n  x: { recipe: r }")).toThrow(/default/);
  });

  it("selects a mode by label or issue type, else default", () => {
    expect(selectMode(yml, { labels: ["content"], issueType: "Task" }).name).toBe("content");
    expect(selectMode(yml, { labels: [], issueType: "blog" }).name).toBe("content");
    expect(selectMode(yml, { labels: ["factory-enabled"], issueType: "Story" }).name).toBe("default");
  });
});

describe("protectedViolations", () => {
  it("flags repo globs and the factory's hard limits", () => {
    expect(protectedViolations(["src/a.ts", "vercel.json", "public/key.txt", ".env.local", "factory.yml", "app/.env"], yml.protected_paths)).toEqual([
      "vercel.json",
      "public/key.txt",
      ".env.local",
      "factory.yml",
      "app/.env",
    ]);
  });
});

describe("routing and factory config", () => {
  const cfg = parseFactoryConfig(`
statuses: { todo: To Do, in_progress: In Progress, done: Done }
repos:
  - { name: web, git: git@github.com:o/web.git, jira: { project: P, component: web } }
  - { name: api, git: git@github.com:o/api.git, jira: { project: P } }
  - { name: site, git: git@github.com:o/site.git, jira: { project: S } }
`);

  it("fills defaults", () => {
    expect(cfg.repos[0]!.base_branch).toBe("main");
    expect(cfg.enable_label).toBe("factory-enabled");
    expect(cfg.max_turns.build).toBe(150);
  });

  it("routes by component first, then project", () => {
    const j = new Jira({ baseUrl: "https://x", email: "e", token: "t" });
    const routeIssue = (repos: typeof cfg.repos, i: { project: string; components: string[] }) => j.route(repos, i);
    expect(routeIssue(cfg.repos, { project: "P", components: ["web"] })?.name).toBe("web");
    expect(routeIssue(cfg.repos, { project: "P", components: [] })?.name).toBe("api");
    expect(routeIssue(cfg.repos, { project: "S", components: [] })?.name).toBe("site");
    expect(routeIssue(cfg.repos, { project: "X", components: [] })).toBeUndefined();
  });

  it("rejects duplicate repo names", () => {
    expect(() =>
      parseFactoryConfig(`
statuses: { todo: a, in_progress: b, done: c }
repos:
  - { name: a, git: "git@github.com:o/x.git", jira: { project: P } }
  - { name: a, git: "git@github.com:o/y.git", jira: { project: Q } }
`),
    ).toThrow(/duplicate/);
  });
});
