// research-to-md: research workbook -> CSV (source of truth) -> Markdown.
//
//   npm run research:convert                         regenerate Markdown from docs/research/csv/
//   npm run research:convert -- --from-xlsx <path>   first import: xlsx -> CSV, then Markdown
//   add --force to overwrite existing CSVs (they are the edited source of truth!)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, toCsv } from "../lib/csv.ts";
import { sheetToTable, slugify } from "./convert.ts";
import { compareWithIndex, parseResearchIndex, renderIndex, renderTabMarkdown, type TabInfo } from "./markdown.ts";
import { readXlsx } from "./xlsx.ts";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export interface Options {
  researchDir: string;
  researchIndex?: string;
  fromXlsx?: string;
  force?: boolean;
  log?: (msg: string) => void;
}

interface ManifestEntry extends TabInfo {
  headerRow: number;
}

const MANIFEST = "tabs.json";

/** Tabs whose first row is data, not a header (checked by reading the workbook). */
const HEADERLESS_TABS = new Set(["Dropdown options"]);

/** Import the workbook into CSVs. Throws if CSVs exist and force is not set. */
export function importXlsx(xlsxPath: string, csvDir: string, force: boolean, log: (m: string) => void): ManifestEntry[] {
  const sheets = readXlsx(readFileSync(xlsxPath));
  const manifest: ManifestEntry[] = [];
  const outputs: { file: string; text: string }[] = [];
  const slugs = new Set<string>();
  for (const sheet of sheets) {
    const slug = slugify(sheet.name);
    if (!slug || slugs.has(slug)) throw new Error(`tab "${sheet.name}" gives an empty or duplicate slug "${slug}"`);
    slugs.add(slug);
    const table = sheetToTable(sheet, HEADERLESS_TABS.has(sheet.name));
    for (const n of table.notes) log(`  note [${sheet.name}] ${n}`);
    manifest.push({ name: sheet.name, slug, hidden: sheet.hidden, headerRow: table.headerRow });
    outputs.push({ file: join(csvDir, `${slug}.csv`), text: toCsv([table.header, ...table.records]) });
  }
  outputs.push({ file: join(csvDir, MANIFEST), text: JSON.stringify(manifest, null, 2) + "\n" });

  const existing = outputs.filter((o) => existsSync(o.file)).map((o) => o.file);
  if (existing.length && !force) {
    throw new Error(
      `refusing to overwrite ${existing.length} existing file(s) in ${csvDir} ` +
        `(the CSVs are the edited source of truth). Re-run with --force to replace them.`,
    );
  }
  mkdirSync(csvDir, { recursive: true });
  for (const o of outputs) writeFileSync(o.file, o.text, "utf8");
  log(`imported ${sheets.length} tabs from ${xlsxPath} into ${csvDir}`);
  return manifest;
}

function loadManifest(csvDir: string, log: (m: string) => void): ManifestEntry[] {
  const manifestPath = join(csvDir, MANIFEST);
  const manifest: ManifestEntry[] = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
  const known = new Set(manifest.map((m) => m.slug));
  const csvs = existsSync(csvDir) ? readdirSync(csvDir).filter((f) => f.endsWith(".csv")) : [];
  for (const f of csvs.sort()) {
    const slug = f.slice(0, -4);
    if (!known.has(slug)) {
      log(`  warning: ${f} is not listed in ${MANIFEST}; using "${slug}" as its tab name`);
      manifest.push({ name: slug, slug, hidden: false, headerRow: 1 });
    }
  }
  return manifest.filter((m) => {
    const ok = csvs.includes(`${m.slug}.csv`);
    if (!ok) log(`  warning: ${MANIFEST} lists "${m.name}" but csv/${m.slug}.csv is missing`);
    return ok;
  });
}

export function run(opts: Options): { tabs: { name: string; rows: number; hidden: boolean }[]; mismatches: string[] } {
  const log = opts.log ?? console.log;
  const csvDir = join(opts.researchDir, "csv");
  if (opts.fromXlsx) importXlsx(opts.fromXlsx, csvDir, !!opts.force, log);

  const manifest = loadManifest(csvDir, log);
  const indexRows: (TabInfo & { rows: number; columns: number })[] = [];
  for (const tab of manifest) {
    const rows = parseCsv(readFileSync(join(csvDir, `${tab.slug}.csv`), "utf8"));
    const header = rows[0] ?? [];
    if (header[0] !== "row") throw new Error(`csv/${tab.slug}.csv: first column must be "row"`);
    rows.slice(1).forEach((r, i) => {
      if (r.length !== header.length)
        log(`  warning: csv/${tab.slug}.csv record ${i + 1} has ${r.length} fields, header has ${header.length}`);
      if (!/^\d+$/.test(r[0] ?? "")) log(`  warning: csv/${tab.slug}.csv record ${i + 1} has row "${r[0]}" (not a number)`);
    });
    writeFileSync(join(opts.researchDir, `${tab.slug}.md`), renderTabMarkdown(tab, rows), "utf8");
    indexRows.push({ ...tab, rows: rows.length - 1, columns: header.length });
  }
  writeFileSync(join(opts.researchDir, "README.md"), renderIndex(indexRows), "utf8");
  log(`wrote ${indexRows.length} Markdown tabs and README.md to ${opts.researchDir}`);

  let mismatches: string[] = [];
  if (opts.researchIndex && existsSync(opts.researchIndex)) {
    mismatches = compareWithIndex(parseResearchIndex(readFileSync(opts.researchIndex, "utf8")), indexRows);
    if (mismatches.length) {
      log(`RESEARCH_INDEX comparison: ${mismatches.length} difference(s) (informational; RESEARCH_INDEX is not edited):`);
      for (const m of mismatches) log(`  - ${m}`);
    } else log("RESEARCH_INDEX comparison: tab names and row counts all match");
  }
  return { tabs: indexRows, mismatches };
}

function main(argv: string[]): number {
  const opts: Options = {
    researchDir: join(REPO_ROOT, "docs", "research"),
    researchIndex: join(REPO_ROOT, "docs", "RESEARCH_INDEX.md"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-xlsx") {
      const p = argv[++i];
      if (!p) throw new Error("--from-xlsx needs a path");
      opts.fromXlsx = resolve(p);
    } else if (a === "--force") opts.force = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: research:convert [--from-xlsx <workbook.xlsx> [--force]]");
      return 0;
    } else throw new Error(`unknown argument ${a}`);
  }
  run(opts);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`research-to-md: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
