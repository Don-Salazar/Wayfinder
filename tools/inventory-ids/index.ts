// inventory-ids: list every identifier that ties the addon to the
// RestedXP/RXPGuides identity (DESIGN § 3 Rebrand map, PIPELINE § 2 P1).
//
//   npm run inventory:ids -- --summary
//   npm run inventory:ids -- --json docs/reports/identifier-inventory.json --md docs/reports/identifier-inventory.md
//   options: --date YYYY-MM-DD (default today), --commit <sha> (default: docs/UPSTREAM.md),
//            --root <dir> (default: repo root)
//
// Read-only over the source tree. Exit 0 on success, 2 on usage errors.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "./rules.ts";
import { buildInventory, renderJson, renderMarkdown, type Inventory } from "./report.ts";
import { addAssetNames, collectSources, prepare, scanFile, trackedFiles, type Hit } from "./scan.ts";

export { CATEGORIES, RULES } from "./rules.ts";
export { buildInventory, renderJson, renderMarkdown } from "./report.ts";
export { analyzeLua, collectSources, prepare, scanFile } from "./scan.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function upstreamCommit(root: string): string {
  const p = join(root, "docs", "UPSTREAM.md");
  if (!existsSync(p)) return "unknown";
  return /Upstream commit\s*\|\s*`([0-9a-f]{40})`/.exec(readFileSync(p, "utf8"))?.[1] ?? "unknown";
}

export function runInventory(root: string, meta: { date: string; commit?: string }): Inventory {
  const all = trackedFiles(root);
  const files = collectSources(root, { files: all });
  const tree = prepare(files);
  addAssetNames(tree, all);
  const perFile = new Map<string, { hits: Hit[]; rawTotal: number }>();
  for (const f of files) perFile.set(f.path, scanFile(f, tree, RULES));
  return buildInventory(files, perFile, tree, { upstreamCommit: meta.commit ?? upstreamCommit(root), date: meta.date });
}

function opt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`wrote ${path}`);
}

function main(argv: string[]): number {
  let jsonOut: string | undefined, mdOut: string | undefined, date: string | undefined, commit: string | undefined, root: string;
  try {
    jsonOut = opt(argv, "--json");
    mdOut = opt(argv, "--md");
    date = opt(argv, "--date");
    commit = opt(argv, "--commit");
    root = resolve(opt(argv, "--root") ?? REPO_ROOT);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("--date must be YYYY-MM-DD");
    return 2;
  }
  const summary = argv.includes("--summary") || (!jsonOut && !mdOut);
  const inv = runInventory(root, { date: date ?? new Date().toISOString().slice(0, 10), ...(commit ? { commit } : {}) });
  if (jsonOut) write(resolve(jsonOut), renderJson(inv));
  if (mdOut) write(resolve(mdOut), renderMarkdown(inv));
  if (summary) {
    console.log(`files: ${inv.scope.scanned} (forever ${inv.scope.byStatus.forever}, other ${inv.scope.byStatus.other}, library ${inv.scope.byStatus.library})`);
    console.log(`raw RXP/RestedXP hits: ${inv.totals.rawHits}, classified ${inv.totals.rawClassified}, unclassified ${inv.totals.rawUnclassified}`);
    console.log("");
    console.log(`${"#".padStart(2)}  ${"category".padEnd(42)} ${"forever".padStart(9)} ${"other".padStart(9)} ${"library".padStart(8)} ${"total".padStart(9)} ${"rxp-hits".padStart(9)}`);
    for (const c of inv.categories)
      console.log(
        `${String(c.num).padStart(2)}  ${c.title.padEnd(42)} ${String(c.occurrences.forever).padStart(9)} ${String(c.occurrences.other).padStart(9)} ${String(c.occurrences.library).padStart(8)} ${String(c.occurrences.total).padStart(9)} ${String(c.raw.total).padStart(9)}`,
      );
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
