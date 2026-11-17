// CSV -> Markdown rendering for docs/research/.

export const SNAPSHOT_DATE = "2026-11-15";

export interface TabInfo {
  name: string;
  slug: string;
  hidden: boolean;
}

/** Escape a value for a GFM table cell, keeping it readable and literal. */
export function mdCell(value: string): string {
  if (/^https?:\/\/\S+$/.test(value)) {
    // Angle-bracket autolink; backslash escapes do not apply inside it.
    return `<${value.replace(/\|/g, "%7C").replace(/>/g, "%3E").replace(/</g, "%3C")}>`;
  }
  return value
    .replace(/&/g, "&amp;")
    .replace(/[\\`*_[\]|<>~]/g, (ch) => (ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "\\" + ch))
    .replace(/\r\n|\r|\n/g, "<br>");
}

export function renderTabMarkdown(tab: TabInfo, rows: string[][]): string {
  const [header = ["row"], ...records] = rows;
  const lines = [
    `# ${tab.name}`,
    "",
    `Research workbook tab **${mdCell(tab.name)}**${tab.hidden ? " (hidden in the workbook)" : ""}: ${records.length} rows.`,
    `Snapshot ${SNAPSHOT_DATE}. Generated from [csv/${tab.slug}.csv](csv/${tab.slug}.csv) — edit the CSV, not this file.`,
    "The `row` column is the spreadsheet row number, cited as `research:" + tab.name + "#<row>`.",
    "",
  ];
  if (records.length === 0) {
    lines.push("_This tab has no data rows._", "");
    return lines.join("\n");
  }
  lines.push("| " + header.map(mdCell).join(" | ") + " |");
  lines.push("|" + header.map(() => " --- |").join(""));
  for (const r of records) {
    const cells = header.map((_, i) => mdCell(r[i] ?? ""));
    lines.push("| " + cells.join(" | ") + " |");
  }
  lines.push("");
  return lines.join("\n");
}

export function renderIndex(tabs: (TabInfo & { rows: number; columns: number })[]): string {
  const lines = [
    "# Research workbook (converted)",
    "",
    `Text conversion of the research workbook \`verified.xlsx\`, snapshot ${SNAPSHOT_DATE}.`,
    "The CSV files in `csv/` are the editable source of truth; the `.md` files and this index are",
    "regenerated from them by `npm run research:convert`. Do not edit the Markdown by hand.",
    "See `docs/RESEARCH_INDEX.md` for what each tab holds and how far to trust it.",
    "Cite a record as `research:<tab>#<row>`, where `<row>` is the value of the `row` column.",
    "",
    "| Tab | Slug | Rows | Columns | Markdown | CSV |",
    "| --- | --- | ---: | ---: | --- | --- |",
  ];
  for (const t of tabs) {
    const name = mdCell(t.name) + (t.hidden ? " (hidden)" : "");
    lines.push(`| ${name} | \`${t.slug}\` | ${t.rows} | ${t.columns - 1} | [${t.slug}.md](${t.slug}.md) | [csv/${t.slug}.csv](csv/${t.slug}.csv) |`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Parse the "## Tabs" table of docs/RESEARCH_INDEX.md into tab name -> expected
 * row count (null for "—"). A cell such as "Racials, Races" with "38 / 10"
 * expands to two entries.
 */
export function parseResearchIndex(md: string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const start = md.search(/^## Tabs\s*$/m);
  if (start < 0) return out;
  const section = md.slice(start).split(/\r?\n/).slice(1);
  let inTable = false;
  for (const line of section) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells[0] === "Tab" || /^-+$/.test(cells[0] ?? "")) continue;
    const names = (cells[0] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const counts = (cells[1] ?? "").split("/").map((s) => s.trim());
    names.forEach((n, i) => {
      const c = counts[i] ?? counts[0] ?? "";
      out.set(n, /^\d+$/.test(c) ? Number(c) : null);
    });
  }
  return out;
}

export function compareWithIndex(
  expected: Map<string, number | null>,
  actual: { name: string; rows: number; hidden: boolean }[],
): string[] {
  const problems: string[] = [];
  const actualByName = new Map(actual.map((a) => [a.name, a]));
  for (const [name, rows] of expected) {
    const a = actualByName.get(name);
    if (!a) problems.push(`tab "${name}" is listed in RESEARCH_INDEX but not in the workbook`);
    else if (rows === null) problems.push(`tab "${name}": RESEARCH_INDEX gives no row count ("—"); workbook has ${a.rows}`);
    else if (rows !== a.rows) problems.push(`tab "${name}": RESEARCH_INDEX says ${rows} rows; workbook has ${a.rows}`);
  }
  for (const a of actual)
    if (!expected.has(a.name))
      problems.push(`tab "${a.name}"${a.hidden ? " (hidden)" : ""} is in the workbook (${a.rows} rows) but not listed in RESEARCH_INDEX`);
  return problems;
}
