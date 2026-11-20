import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeArgs, describeEvent } from "../src/claude.js";
import { run } from "../src/exec.js";
import { StateStore } from "../src/state.js";
import { ago, statusRows, table } from "../src/status.js";

describe("describeEvent", () => {
  it("summarises each tool call in an assistant message", () => {
    const ev = {
      type: "assistant",
      message: {
        content: [
          { type: "text" },
          { type: "tool_use", name: "Edit", input: { file_path: "src/components/CommandPalette.astro" } },
          { type: "tool_use", name: "Bash", input: { command: "npm test\n  -- --run" } },
          { type: "tool_use", name: "mcp__playwright__browser_navigate", input: { url: "http://localhost:4321/" } },
          { type: "tool_use", name: "TodoWrite", input: {} },
        ],
      },
    };
    expect(describeEvent(ev)).toEqual([
      "Edit src/components/CommandPalette.astro",
      "Bash npm test -- --run",
      "browser navigate http://localhost:4321/",
      "TodoWrite",
    ]);
  });
  it("ignores non-assistant events and truncates long args", () => {
    expect(describeEvent({ type: "user" })).toEqual([]);
    const [s] = describeEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "x".repeat(300) } }] } });
    expect(s!.length).toBeLessThan(110);
  });
  it("asks claude for a streamed transcript", () => {
    const a = claudeArgs({ agent: "a", prompt: "", cwd: ".", allowedTools: [], maxTurns: 1, label: "l" }, "/m");
    expect(a).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--verbose"]));
  });
});

describe("exec onLine", () => {
  it("delivers complete lines, including a final unterminated one", async () => {
    const lines: string[] = [];
    await run("bash", ["-c", "printf 'a\\nb'; sleep 0.05; printf 'c\\n\\nd'"], { onLine: (l) => lines.push(l) });
    expect(lines).toEqual(["a", "bc", "d"]);
  });
});

describe("state steps and status", () => {
  it("tracks the running step and clears it at the end", () => {
    const s = new StateStore(join(mkdtempSync(join(tmpdir(), "st-")), "state.json"));
    s.step("KAN-4", "portfolio", "build", "installing dependencies");
    expect(s.get("KAN-4")).toMatchObject({ stage: "build", step: "installing dependencies" });
    const now = Date.parse(s.get("KAN-4")!.updatedAt!) + 120_000;
    expect(statusRows(s.all(), now)[0]).toEqual(["KAN-4", "RUNNING", "build: installing dependencies", "2m ago", "-", "-"]);
    s.endStage("KAN-4", "portfolio", "build", "blocked");
    expect(s.get("KAN-4")!.stage).toBeUndefined();
    expect(statusRows(s.all())[0]![1]).toBe("BLOCKED");
  });
  it("formats ages and tables", () => {
    const t = Date.parse("2026-11-20T10:00:00Z");
    expect(ago("2026-11-20T09:59:30Z", t)).toBe("30s ago");
    expect(ago("2026-11-20T07:00:00Z", t)).toBe("3h ago");
    expect(ago(undefined)).toBe("-");
    expect(table([["KAN-1", "idle", "build: PR", "1m ago", "$1.00", "-"]]).split("\n")[0]).toMatch(/^TICKET\s+STATE/);
  });
});
