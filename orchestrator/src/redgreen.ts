// The factory's own check of the builder's TDD claim. It doesn't trust the
// agent's report: it runs the tests at the red commit (must fail) and at HEAD
// (must pass).

export interface RedGreenDeps {
  redCommits(): Promise<string[]>;
  head(): Promise<string>;
  checkout(ref: string): Promise<void>;
  install(): Promise<void>;
  test(): Promise<{ code: number; output: string }>;
}

export type RedGreenResult = { ok: true; red: string; green: string } | { ok: false; reason: string };

export async function checkRedGreen(d: RedGreenDeps): Promise<RedGreenResult> {
  const reds = await d.redCommits();
  if (reds.length === 0) return { ok: false, reason: "No commit with the `Factory-Phase: red` trailer. Tests must be committed before the implementation." };
  if (reds.length > 1) return { ok: false, reason: `Found ${reds.length} red commits; exactly one is allowed.` };
  const red = reds[0]!;
  const green = await d.head();
  if (green === red) return { ok: false, reason: "The red commit is the last commit: there is no implementation after it." };

  try {
    await d.checkout(red);
    await d.install();
    const atRed = await d.test();
    if (atRed.code === 0) {
      return { ok: false, reason: `Tests **passed** at the red commit ${red.slice(0, 8)}, so they don't prove the feature was missing.` };
    }
  } finally {
    await d.checkout(green);
  }

  await d.install();
  const atGreen = await d.test();
  if (atGreen.code !== 0) {
    return { ok: false, reason: `Tests fail at HEAD ${green.slice(0, 8)}:\n\n\`\`\`\n${atGreen.output.slice(-3000)}\n\`\`\`` };
  }
  return { ok: true, red, green };
}

/** Text between `## <heading>` and the next `## ` / STATUS line in an agent reply. */
export function section(reply: string, heading: string): string {
  const m = reply.match(new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\nSTATUS:|$)`, "i"));
  return m?.[1]?.trim() ?? "";
}

export function agentStatus(reply: string): { status: "DONE" | "BLOCKED" | "UNKNOWN"; reason: string } {
  const m = reply.match(/STATUS:\s*(DONE|BLOCKED)\b(.*)$/m);
  if (!m) return { status: "UNKNOWN", reason: "" };
  return { status: m[1] as "DONE" | "BLOCKED", reason: (m[2] ?? "").replace(/^[\s:—-]+/, "").trim() || reply.slice(-1500) };
}
