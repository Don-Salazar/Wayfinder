// dump-to-research: turn a /wf dump into research files.
//
//   npm run dump:research -- <Wayfinder.lua SavedVariables file | JSON from npm run savedvars>
//
// Reads WayfinderData.dump (through tools/read-savedvars for .lua input) and
// writes docs/research/game-data/<YYYY-MM-DD>-<class>-<race>-L<level>/:
// spells.csv, racials.csv, talents.csv, trainer.csv, quests.csv, items.csv,
// stats.csv, maps.csv and README.md (counts and the API path each section
// used). When docs/research/csv exists it also writes diff.md: every
// disagreement between the dump and the workbook tabs spell-ids,
// class-abilities, quest-rewards, dungeon-loot, plus the UiMapIDs seen for
// the zone-ids rows (see convert.ts for the matching rules).
// docs/research/ is git-ignored; nothing here is committed.
//
// Exit codes: 0 ok, 1 input or parse error, 2 usage.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "../lib/csv.ts";
import { parseSavedVariables } from "../read-savedvars/parse.ts";
import { buildDiff, diffMarkdown, type Dump, findDump, folderName, readme, toCsvs } from "./convert.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const RESEARCH_CSV = "docs/research/csv";
export const OUT_ROOT = "docs/research/game-data";
export const DIFF_TABS = ["spell-ids", "class-abilities", "trainers", "quest-rewards", "dungeon-loot", "zone-ids"];

/** Load the dump from a SavedVariables .lua file or a JSON file. */
export function loadDump(file: string): Dump {
  const text = readFileSync(file, "utf8");
  const data: unknown = extname(file).toLowerCase() === ".json" ? JSON.parse(text) : parseSavedVariables(text);
  return findDump(data);
}

/** Research CSVs by tab name (only those present). */
export function readResearch(csvDir: string): Record<string, string[][]> | undefined {
  if (!existsSync(csvDir)) return undefined;
  const tabs: Record<string, string[][]> = {};
  for (const tab of DIFF_TABS) {
    const p = join(csvDir, `${tab}.csv`);
    if (existsSync(p)) tabs[tab] = parseCsv(readFileSync(p, "utf8"));
  }
  return tabs;
}

export interface ConvertResult {
  dir: string;
  files: string[];
  diffRows?: number;
}

/** Write the research files for `dump` under outRoot; diff when research is given. */
export function convert(dump: Dump, outRoot: string, research?: Record<string, string[][]>): ConvertResult {
  const folder = folderName(dump.meta);
  const dir = join(outRoot, folder);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const [name, text] of Object.entries(toCsvs(dump))) {
    writeFileSync(join(dir, name), text, "utf8");
    files.push(name);
  }
  writeFileSync(join(dir, "README.md"), readme(dump, folder), "utf8");
  files.push("README.md");
  let diffRows: number | undefined;
  if (research) {
    const diff = buildDiff(dump, research);
    writeFileSync(join(dir, "diff.md"), diffMarkdown(diff, folder), "utf8");
    files.push("diff.md");
    diffRows = diff.rows.length;
  }
  return { dir, files, diffRows };
}

function main(argv: string[]): number {
  const inputs = argv.filter((a) => !a.startsWith("--"));
  if (inputs.length !== 1 || argv.some((a) => a.startsWith("--"))) {
    console.error("usage: npm run dump:research -- <Wayfinder.lua SavedVariables file | dump JSON>");
    return 2;
  }
  const dump = loadDump(inputs[0]!);
  const research = readResearch(join(REPO_ROOT, RESEARCH_CSV));
  const r = convert(dump, join(REPO_ROOT, OUT_ROOT), research);
  console.log(`dump-to-research: wrote ${r.files.join(", ")} to ${r.dir}`);
  if (r.diffRows === undefined) console.log(`dump-to-research: ${RESEARCH_CSV} not found; no diff.md.`);
  else console.log(`dump-to-research: diff.md lists ${r.diffRows} disagreement(s).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`dump-to-research: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
