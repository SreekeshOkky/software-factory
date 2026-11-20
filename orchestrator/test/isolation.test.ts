import { afterEach, describe, expect, it } from "vitest";
import { spawnArgs } from "../src/exec.js";

afterEach(() => {
  delete process.env.AGENT_USER;
});

describe("agent isolation", () => {
  it("runs agent commands through sudo with only explicit variables", () => {
    process.env.AGENT_USER = "agent";
    process.env.GH_TOKEN = "secret";
    const s = spawnArgs("bash", ["-lc", "npm test"], { asAgent: true, env: { CI: "true", PORT: "4321" } });
    expect(s.file).toBe("sudo");
    expect(s.argv).toEqual(["-n", "-H", "-u", "agent", "/usr/local/bin/agent-exec", "CI=true", "PORT=4321", "bash", "-lc", "npm test"]);
    expect(s.argv.join(" ")).not.toContain("secret");
    delete process.env.GH_TOKEN;
  });
  it("runs factory commands directly", () => {
    process.env.AGENT_USER = "agent";
    expect(spawnArgs("git", ["push"], {}).file).toBe("git");
  });
  it("falls back to the current user outside the container", () => {
    expect(spawnArgs("claude", ["-p"], { asAgent: true }).file).toBe("claude");
  });
});
