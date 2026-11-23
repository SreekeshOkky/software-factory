// Diff helpers any code host can use to decide which review comments can be
// posted inline. Hosts reject inline comments on lines outside the diff.
import type { ReviewComment } from "./types.js";

/** New-side line numbers per file that hosts accept for inline comments (added + context lines). */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const ok = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  let n = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git")) {
      lines = undefined;
      continue;
    }
    if (l.startsWith("+++ ")) {
      const path = l.slice(4).replace(/^b\//, "");
      lines = path === "/dev/null" ? undefined : new Set();
      if (lines) ok.set(path, lines);
      continue;
    }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (!lines || l.startsWith("--- ") || l.startsWith("\\")) continue;
    if (l.startsWith("+") || l.startsWith(" ")) lines.add(n++);
  }
  return ok;
}

/** Splits review comments into ones a host will accept inline and ones that must go in the summary. */
export function splitComments(diff: string, comments: ReviewComment[]): { inline: ReviewComment[]; folded: ReviewComment[] } {
  const ok = commentableLines(diff);
  const inline: ReviewComment[] = [];
  const folded: ReviewComment[] = [];
  for (const c of comments) (ok.get(c.path)?.has(c.line) ? inline : folded).push(c);
  return { inline, folded };
}

/** A review comment as a Markdown bullet, for the summary. */
export const bullet = (c: ReviewComment) => `- \`${c.path}:${c.line}\` ${c.severity ? `**${c.severity}** ` : ""}${c.body}`;

/** The summary with comments that couldn't go inline appended under `heading`. */
export function withComments(summary: string, comments: ReviewComment[], heading = "Comments on lines outside the diff"): string {
  return comments.length ? `${summary}\n\n### ${heading}\n${comments.map(bullet).join("\n")}` : summary;
}

/** The text of an inline comment, with its severity. */
export const inlineBody = (c: ReviewComment) => (c.severity ? `**${c.severity}**: ${c.body}` : c.body);
