// analyze-log: turn field logs into a corrections report (docs/FIELD_LOG.md
// section 4).
//
//   npm run analyze:log -- <SavedVariables file(s)> [--out docs/reports] [--research docs/research/csv]
//
// Inputs are SavedVariables .lua files (or JSON from `npm run savedvars`).
// WayfinderCharData.log lives in the per-character file
// (WTF/Account/<acct>/<realm>/<char>/SavedVariables/Wayfinder.lua);
// WayfinderData.selftest in the account file. Pass both to get both.
// For each install ID it writes <out>/<date>-<installId>.md and
// <date>-<installId>.patch.md, where <date> is the newest session date in
// the log. Findings also in the most recent earlier report for the same
// install ID are listed first. Research quest tabs (riverglades-quests.csv,
// shendralas-quests.csv) are read from --research if present.
//
// Exit codes: 0 ok, 1 input or parse error (or no field log found), 2 usage.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSavedVariables } from "../read-savedvars/parse.ts";
import {
  buildReport,
  type CharacterLog,
  findLogs,
  type Obj,
  type PreviousSummary,
  previousReportName,
  QUEST_TABS,
  questRows,
  readSummary,
  reportDate,
  reportName,
  type ResearchRow,
} from "./analyze.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_OUT = "docs/reports";
export const DEFAULT_RESEARCH = "docs/research/csv";

export interface Args {
  files: string[];
  out: string;
  research: string;
}

export function parseArgs(argv: string[]): Args | string {
  const args: Args = { files: [], out: join(REPO_ROOT, DEFAULT_OUT), research: join(REPO_ROOT, DEFAULT_RESEARCH) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out" || a === "--research") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return `${a} needs a value`;
      if (a === "--out") args.out = resolve(v);
      else args.research = resolve(v);
    } else if (a.startsWith("--")) return `unknown option ${a}`;
    else args.files.push(a);
  }
  if (!args.files.length) return "give at least one SavedVariables file";
  return args;
}

/** Parse one input file (SavedVariables .lua or JSON). */
export function loadFile(file: string): unknown {
  const text = readFileSync(file, "utf8");
  return extname(file).toLowerCase() === ".json" ? JSON.parse(text) : parseSavedVariables(text);
}

/** Research quest rows from the quest tabs present in dir, or undefined if none are. */
export function readResearch(dir: string): ResearchRow[] | undefined {
  let found = false;
  const rows: ResearchRow[] = [];
  for (const tab of QUEST_TABS) {
    const p = join(dir, `${tab}.csv`);
    if (!existsSync(p)) continue;
    found = true;
    rows.push(...questRows(tab, readFileSync(p, "utf8")));
  }
  return found ? rows : undefined;
}

export function findPrevious(outDir: string, installId: string, current: string): PreviousSummary | undefined {
  if (!existsSync(outDir)) return undefined;
  const name = previousReportName(readdirSync(outDir), installId, current);
  if (!name) return undefined;
  const summary = readSummary(readFileSync(join(outDir, name), "utf8"));
  if (!summary) return undefined;
  return { file: name, findings: new Set(summary.findings) };
}

export interface Written {
  installId: string;
  report: string;
  patch: string;
  findings: number;
  again: number;
}

/** Analyze parsed inputs and write the reports. Returns what was written. */
export function analyze(inputs: { source: string; data: unknown }[], outDir: string, research?: ResearchRow[]): Written[] {
  const logs: CharacterLog[] = [];
  let selftest: Obj | undefined;
  for (const { source, data } of inputs) {
    const found = findLogs(data, source);
    logs.push(...found.logs);
    if (found.selftest) selftest = found.selftest;
  }
  const byInstall = new Map<string, CharacterLog[]>();
  for (const log of logs) byInstall.set(log.installId, [...(byInstall.get(log.installId) ?? []), log]);
  mkdirSync(outDir, { recursive: true });
  const written: Written[] = [];
  for (const installId of [...byInstall.keys()].sort()) {
    const group = byInstall.get(installId)!;
    const current = reportName(reportDate(group), installId);
    const previous = findPrevious(outDir, installId, current);
    const report = buildReport({ installId, logs: group, selftest, research, previous });
    const reportPath = join(outDir, report.name);
    const patchPath = join(outDir, report.name.replace(/\.md$/, ".patch.md"));
    writeFileSync(reportPath, report.markdown, "utf8");
    writeFileSync(patchPath, report.patch, "utf8");
    const again = previous ? report.findings.filter((f) => previous.findings.has(f)).length : 0;
    written.push({ installId, report: reportPath, patch: patchPath, findings: report.findings.length, again });
  }
  return written;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(`analyze-log: ${args}`);
    console.error("usage: npm run analyze:log -- <SavedVariables file(s)> [--out docs/reports] [--research docs/research/csv]");
    return 2;
  }
  const inputs = args.files.map((file) => ({ source: file, data: loadFile(file) }));
  const research = readResearch(args.research);
  const written = analyze(inputs, args.out, research);
  if (!written.length) {
    console.error("analyze-log: no WayfinderCharData.log in the input (pass the per-character Wayfinder.lua).");
    return 1;
  }
  for (const w of written) {
    console.log(`analyze-log: ${w.installId}: wrote ${w.report} and ${w.patch} (${w.findings} finding(s), ${w.again} again)`);
  }
  if (!research) console.log(`analyze-log: no research quest tabs in ${args.research}; section 5 lists no comparison.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`analyze-log: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
