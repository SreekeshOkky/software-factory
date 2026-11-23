import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseFactoryConfig } from "../src/config.js";
import { basicAuthGitEnv, gitHostname, gitPath } from "../src/hosts/git.js";
import { CodeHosts, createCodeHosts, inferHostType, VENDORS, type CodeHost } from "../src/hosts/index.js";

const base = "statuses: { todo: To Do, in_progress: In Progress, done: Done }\n";
const repo = (extra: string) => parseFactoryConfig(`${base}repos: [{ name: a, tracker: { type: jira, project: P }, ${extra} }]`).repos[0]!;

describe("code host registry", () => {
  it("registers every vendor under its own id, with a config schema and hostnames", () => {
    for (const [key, v] of Object.entries(VENDORS)) {
      expect(v.id).toBe(key);
      expect(v.id).toMatch(/^[a-z0-9-]+$/);
      expect(typeof v.repoConfig.safeParse).toBe("function");
      expect(Array.isArray(v.hostnames)).toBe(true);
    }
  });
});

describe("repos[].host", () => {
  it("is inferred from a github.com URL, ssh or https", () => {
    expect(repo("git: git@github.com:o/r.git").host).toEqual({ type: "github" });
    expect(repo("git: https://github.com/o/r").host).toEqual({ type: "github" });
    expect(inferHostType("git@gitlab.example.com:o/r.git")).toBeUndefined();
  });
  it("is required when the hostname isn't known", () => {
    expect(() => repo("git: git@git.example.com:o/r.git")).toThrow(/missing `host: \{ type: ... \}`/);
  });
  it("accepts an explicit block and rejects unknown types", () => {
    expect(repo("git: git@github.com:o/r.git, host: { type: github }").host).toEqual({ type: "github" });
    expect(() => repo("git: git@github.com:o/r.git, host: { type: nope }")).toThrow(/unknown code host type "nope"/);
  });
});

describe("git URL helpers", () => {
  it("reads hostname and path from ssh and https URLs, with subgroups", () => {
    expect(gitHostname("git@gitlab.com:group/sub/repo.git")).toBe("gitlab.com");
    expect(gitHostname("https://bitbucket.org/ws/repo.git")).toBe("bitbucket.org");
    expect(gitHostname("not a url")).toBeUndefined();
    expect(gitPath("git@gitlab.com:group/sub/repo.git")).toBe("group/sub/repo");
    expect(gitPath("https://bitbucket.org/ws/repo.git/")).toBe("ws/repo");
    expect(() => gitPath("https://example.com/")).toThrow(/owner\/repo/);
  });

  it("gives git credentials and the ssh rewrite through env only", () => {
    const env = basicAuthGitEnv("github.com", "x-access-token", "tok");
    const cfg = execFileSync("git", ["config", "--get-regexp", "^(url|http)\\."], { env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).toString();
    expect(cfg).toContain("url.https://github.com/.insteadof git@github.com:");
    expect(cfg).toContain(`http.https://github.com/.extraheader Authorization: Basic ${Buffer.from("x-access-token:tok").toString("base64")}`);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("CodeHosts", () => {
  it("makes one instance per type in use", () => {
    const made: string[] = [];
    const fake = (id: string) => ({ id }) as CodeHost;
    const r = (name: string, type: string) => ({ name, git: "x", base_branch: "main", tracker: { type: "jira" }, host: { type } });
    const h = new CodeHosts([r("a", "one"), r("b", "two"), r("c", "one")], (t) => (made.push(t), fake(t)));
    expect(made).toEqual(["one", "two"]);
    expect(h.for(r("b", "two")).id).toBe("two");
  });

  it("asks only for the env of hosts in use, and builds GitHub links", () => {
    const cfg = parseFactoryConfig(`${base}repos: [{ name: a, git: "git@github.com:o/r.git", tracker: { type: jira, project: P } }]`);
    expect(() => createCodeHosts(cfg, true, "/tmp", {})).toThrow("missing env GH_TOKEN (needed by the GitHub code host)");
    const gh = createCodeHosts(cfg, true, "/tmp", { GH_TOKEN: "t" }).for(cfg.repos[0]!);
    expect(gh.describe(cfg.repos[0]!)).toBe("github:o/r");
    expect(gh.fileUrl(cfg.repos[0]!, "factory/K-1", ".factory/evidence/K-1/a.png")).toBe("https://github.com/o/r/blob/factory/K-1/.factory/evidence/K-1/a.png?raw=true");
    expect(gh.remote(cfg.repos[0]!).url).toBe("git@github.com:o/r.git");
  });
});
