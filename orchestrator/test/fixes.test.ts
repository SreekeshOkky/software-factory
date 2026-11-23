import { describe, expect, it } from "vitest";
import { commentableLines, splitComments } from "../src/github.js";
import { Jira } from "../src/jira.js";
import { retryHint } from "../src/stages/context.js";

const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+line 1
+line 2
+line 3
diff --git a/src/old.ts b/src/old.ts
--- a/src/old.ts
+++ b/src/old.ts
@@ -10,4 +10,5 @@ function x() {
 context 10
-removed
+added 11
+added 12
 context 13
diff --git a/gone.ts b/gone.ts
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

describe("review comment lines", () => {
  it("maps new-side lines that GitHub accepts", () => {
    const m = commentableLines(diff);
    expect([...m.get("src/new.ts")!]).toEqual([1, 2, 3]);
    expect([...m.get("src/old.ts")!]).toEqual([10, 11, 12, 13]);
    expect(m.has("gone.ts")).toBe(false);
  });
  it("folds comments that point outside the diff (the KAN-4 422)", () => {
    const { inline, folded } = splitComments(diff, [
      { path: "src/new.ts", line: 2, body: "ok" },
      { path: "src/new.ts", line: 813, body: "hallucinated line" },
      { path: "src/old.ts", line: 5, body: "unchanged region" },
      { path: "src/other.ts", line: 1, body: "file not in PR" },
    ]);
    expect(inline.map((c) => c.line)).toEqual([2]);
    expect(folded.map((c) => c.body)).toEqual(["hallucinated line", "unchanged region", "file not in PR"]);
  });
});

describe("Jira retries", () => {
  it("retries network errors and 5xx, then succeeds", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) throw Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND x") });
      if (n === 2) return new Response("", { status: 503 });
      return new Response(JSON.stringify({ issues: [{ key: "K-1" }] }));
    }) as unknown as typeof fetch;
    const j = new Jira({ baseUrl: "https://x", email: "e", token: "t", fetchImpl, retryDelayMs: 1 });
    expect(await j.search("q")).toEqual(["K-1"]);
    expect(n).toBe(3);
  });
  it("gives up with a short message", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND x") });
    }) as unknown as typeof fetch;
    const j = new Jira({ baseUrl: "https://x", email: "e", token: "t", fetchImpl, retryDelayMs: 1 });
    await expect(j.search("q")).rejects.toThrow("Jira unreachable after 4 tries: getaddrinfo ENOTFOUND x");
  });
  it("does not retry 4xx", async () => {
    let n = 0;
    const fetchImpl = (async () => (n++, new Response("nope", { status: 400 }))) as unknown as typeof fetch;
    const j = new Jira({ baseUrl: "https://x", email: "e", token: "t", fetchImpl, retryDelayMs: 1 });
    await expect(j.search("q")).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
});

describe("retryHint", () => {
  it("tells a blocked build to go back to To Do", () => {
    expect(retryHint("build", "To Do")).toContain("move the ticket back to **To Do**");
  });
  it("other stages only need the label removed", () => {
    const h = retryHint("verify", "To Do");
    expect(h).toContain("factory-blocked");
    expect(h).not.toContain("To Do");
  });
});
