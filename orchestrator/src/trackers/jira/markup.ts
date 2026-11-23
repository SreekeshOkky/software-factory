// Markdown -> Jira wiki markup, for comments. Jira v2 endpoints take wiki markup strings.

/** Minimal Markdown -> Jira wiki markup: headings, bold, code, links, fenced code, tables. */
export function mdToWiki(md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let inCode = false;
  let tableHeader = true;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      out.push(inCode ? "{code}" : fence[1] ? `{code:${fence[1]}}` : "{code}");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // separator row
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()) || " ");
      out.push(tableHeader ? `||${cells.join("||")}||` : `|${cells.join("|")}|`);
      tableHeader = false;
      continue;
    }
    tableHeader = true;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`h${h[1]!.length}. ${inline(h[2]!)}`);
      continue;
    }
    out.push(inline(line.replace(/^(\s*)[-*]\s+/, (_m, sp: string) => `${"*".repeat(sp.length / 2 + 1)} `)));
  }
  return out.join("\n");
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "{{$1}}")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "[$1|$2]");
}
