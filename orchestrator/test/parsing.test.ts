import { describe, expect, it } from "vitest";
import { claudeArgs, lastJsonBlock, mcpConfig } from "../src/claude.js";
import type { Env } from "../src/config.js";
import { slugFromGitUrl } from "../src/github.js";
import { buildPrompt, verifyPrompt } from "../src/prompts.js";
import { parseRepoFactoryYml } from "../src/repo.js";
import { parseReview } from "../src/stages/review.js";
import { parseVerdicts, verdictTable } from "../src/stages/verify.js";

const issue = {
  key: "PORT-7",
  project: "PORT",
  summary: "Add dark mode toggle to footer",
  description: "AC:\n* toggle in footer\n* persists after reload",
  status: "To Do",
  issueType: "Story",
  labels: ["factory-enabled"],
  components: [],
  url: "https://x/browse/PORT-7",
};

describe("agent output parsing", () => {
  it("takes the last json block", () => {
    expect(lastJsonBlock('```json\n{"a":1}\n```\ntext\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(lastJsonBlock("no json")).toBeNull();
    expect(lastJsonBlock("```json\n{broken\n```")).toBeNull();
  });

  it("parses a review and drops malformed comments", () => {
    const r = parseReview(
      '```json\n{"summary":"ok","comments":[{"path":"a.ts","line":3,"body":"bug"},{"path":"b.ts","line":0,"body":"x"},{"line":2}]}\n```',
    );
    expect(r?.comments).toEqual([{ path: "a.ts", line: 3, body: "bug" }]);
    expect(parseReview("nothing")).toBeNull();
  });

  it("parses verdicts and renders a table", () => {
    const rows = parseVerdicts(
      'table...\n```json\n{"verdicts":[{"n":1,"criterion":"toggle | footer","verdict":"PASS","evidence":"seen"},{"n":2,"criterion":"persists","verdict":"FAIL","evidence":"reset"},{"n":3,"verdict":"MAYBE"}]}\n```',
    );
    expect(rows).toHaveLength(2);
    const t = verdictTable(rows!);
    expect(t).toContain("| 1 | toggle / footer | PASS | seen |");
    expect(t).toContain("**FAIL**");
  });
});

describe("prompts keep agents in their lane", () => {
  const yml = parseRepoFactoryYml("install: npm ci\ntest: npm test\nstart: s\nport: 1\nticket_modes:\n  default: { recipe: one test per AC }");
  it("builder prompt carries rules, recipe and trailer", () => {
    const p = buildPrompt(issue, yml, { name: "default", recipe: "one test per AC" }, "main");
    expect(p).toContain("Follow CLAUDE.md");
    expect(p).toContain("one test per AC");
    expect(p).toContain("`Jira: PORT-7`");
    expect(p).toContain("red-green skill");
  });
  it("verifier prompt has the ticket but nothing about code or PRs", () => {
    const p = verifyPrompt(issue, "http://localhost:4321", "Footer is on every page");
    expect(p).toContain("persists after reload");
    expect(p).not.toMatch(/diff|pull request|source code/i);
  });
});

describe("claude invocation", () => {
  const env = { jiraEmail: "e", jiraToken: "t", jiraRovoMcp: false, jiraRovoMcpUrl: "u" } as Env;
  it("uses strict MCP config and an allowlist", () => {
    const a = claudeArgs({ agent: "pr-reviewer", prompt: "", cwd: ".", allowedTools: ["Read", "Grep"], maxTurns: 5, label: "x" }, "/m.json");
    expect(a).toEqual(expect.arrayContaining(["-p", "--agent", "pr-reviewer", "--strict-mcp-config", "--allowedTools", "Read,Grep"]));
  });
  it("only adds servers a run asks for", () => {
    expect(mcpConfig(env, {})).toEqual({ mcpServers: {} });
    expect(Object.keys((mcpConfig(env, { playwrightOutputDir: "/o", jira: true }) as { mcpServers: object }).mcpServers)).toEqual(["playwright"]);
    expect(Object.keys((mcpConfig({ ...env, jiraRovoMcp: true }, { jira: true }) as { mcpServers: object }).mcpServers)).toEqual(["atlassian"]);
  });
});

describe("slugFromGitUrl", () => {
  it("handles ssh and https", () => {
    expect(slugFromGitUrl("git@github.com:SreekeshOkky/portfolio.git")).toBe("SreekeshOkky/portfolio");
    expect(slugFromGitUrl("https://github.com/o/r")).toBe("o/r");
  });
});
