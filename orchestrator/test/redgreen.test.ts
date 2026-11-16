import { describe, expect, it } from "vitest";
import { agentStatus, checkRedGreen, section, type RedGreenDeps } from "../src/redgreen.js";

/** Fake repo: test exit code depends on which commit is checked out. */
function fake(reds: string[], head: string, codes: Record<string, number>) {
  let at = head;
  const calls: string[] = [];
  const deps: RedGreenDeps = {
    redCommits: async () => reds,
    head: async () => head,
    checkout: async (r) => {
      at = r;
      calls.push(`checkout ${r}`);
    },
    install: async () => void calls.push(`install ${at}`),
    test: async () => ({ code: codes[at] ?? 0, output: `ran at ${at}` }),
  };
  return { deps, calls };
}

describe("checkRedGreen", () => {
  it("passes when red fails and green passes", async () => {
    const { deps, calls } = fake(["r1"], "g1", { r1: 1, g1: 0 });
    expect(await checkRedGreen(deps)).toEqual({ ok: true, red: "r1", green: "g1" });
    expect(calls).toEqual(["checkout r1", "install r1", "checkout g1", "install g1"]);
  });

  it("rejects a missing red commit", async () => {
    const r = await checkRedGreen(fake([], "g1", {}).deps);
    expect(r.ok).toBe(false);
  });

  it("rejects more than one red commit", async () => {
    const r = await checkRedGreen(fake(["a", "b"], "g1", {}).deps);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("exactly one") });
  });

  it("rejects red == head (no implementation)", async () => {
    const r = await checkRedGreen(fake(["g1"], "g1", { g1: 1 }).deps);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("no implementation") });
  });

  it("rejects tests that already pass at red", async () => {
    const { deps, calls } = fake(["r1"], "g1", { r1: 0, g1: 0 });
    expect(await checkRedGreen(deps)).toMatchObject({ ok: false, reason: expect.stringContaining("passed") });
    expect(calls.at(-1)).toBe("checkout g1"); // always returns to head
  });

  it("rejects failing tests at head", async () => {
    const r = await checkRedGreen(fake(["r1"], "g1", { r1: 1, g1: 2 }).deps);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("ran at g1") });
  });
});

describe("builder reply parsing", () => {
  const reply = "work...\n## Summary\nAdded X.\n\n## Acceptance criteria\n| a | b |\n\nSTATUS: DONE\n";
  it("extracts sections and status", () => {
    expect(section(reply, "Summary")).toBe("Added X.");
    expect(section(reply, "Acceptance criteria")).toBe("| a | b |");
    expect(agentStatus(reply).status).toBe("DONE");
  });
  it("reads a blocked reason", () => {
    expect(agentStatus("STATUS: BLOCKED - criteria are vague")).toEqual({ status: "BLOCKED", reason: "criteria are vague" });
    expect(agentStatus("no status").status).toBe("UNKNOWN");
  });
});
