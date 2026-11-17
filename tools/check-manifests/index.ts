// check-manifests: every file a TOC/XML manifest loads must exist, with the
// same letter case as on disk (Linux CI is case-sensitive; WoW is not).
//
//   npm run check:manifests                       check against baseline.json
//   npm run check:manifests -- --write-baseline   accept the current findings
//   npm run check:manifests -- --list camelot     print the load order
//
// Exit 0 when every finding is in the baseline; 1 on any new finding.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addonNames, FileIndex, GAME_TYPES, loadOrder, type Finding, type GameType, type LoadResult } from "./manifest.ts";

export { loadOrder, loadOrderByGameType, GAME_TYPES } from "./manifest.ts";
export type { GameType, LoadedFile, LoadResult, Finding } from "./manifest.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BASELINE = fileURLToPath(new URL("./baseline.json", import.meta.url));

export interface BaselineEntry {
  gameType: GameType;
  kind: Finding["kind"];
  from: string;
  ref: string;
  note?: string;
}

/** Baseline key ignores line numbers so unrelated edits don't invalidate it. */
export function findingKey(f: { gameType: string; kind: string; from: string; ref: string }): string {
  return `${f.gameType}|${f.kind}|${f.from}|${f.ref}`;
}

export function compareToBaseline(findings: Finding[], baseline: BaselineEntry[]): { fresh: Finding[]; stale: BaselineEntry[] } {
  const base = new Set(baseline.map(findingKey));
  const seen = new Set(findings.map(findingKey));
  return {
    fresh: findings.filter((f) => !base.has(findingKey(f))),
    stale: baseline.filter((b) => !seen.has(findingKey(b))),
  };
}

export function analyze(root: string): LoadResult[] {
  const index = FileIndex.fromDisk(root);
  const results: LoadResult[] = [];
  for (const addon of addonNames(index)) for (const g of GAME_TYPES) results.push(loadOrder(g, { root, index, addon }));
  return results;
}

function fmt(f: Finding): string {
  return `  ${f.kind.padEnd(8)} ${f.from}${f.line ? ":" + f.line : ""}  "${f.ref}"  ${f.detail}`;
}

function main(argv: string[]): number {
  const root = REPO_ROOT;
  const results = analyze(root);
  const listIdx = argv.indexOf("--list");
  if (listIdx >= 0) {
    const g = (argv[listIdx + 1] ?? "camelot") as GameType;
    for (const r of results.filter((x) => x.gameType === g))
      for (const f of r.files) console.log(`${f.exists ? " " : "!"} ${f.kind.padEnd(4)} ${f.path}${f.via && f.via !== "toc" ? `  (${f.via})` : ""}`);
    return 0;
  }
  const findings = results.flatMap((r) => r.findings);

  if (argv.includes("--write-baseline")) {
    const unique = new Map<string, BaselineEntry>();
    for (const f of findings) unique.set(findingKey(f), { gameType: f.gameType, kind: f.kind, from: f.from, ref: f.ref, note: f.detail });
    writeFileSync(BASELINE, JSON.stringify({ description: "Known findings in the unmodified upstream tree (RXPGuides 22e6ce26). New findings fail the check.", findings: [...unique.values()] }, null, 2) + "\n");
    console.log(`wrote ${unique.size} baseline entries to ${BASELINE}`);
    return 0;
  }

  for (const r of results) {
    const byKind = (k: Finding["kind"]) => r.findings.filter((f) => f.kind === k).length;
    const files = r.files.filter((f) => f.kind === "lua" || f.kind === "xml");
    console.log(
      `[${r.gameType}] toc=${r.toc ?? "(none: addon not loaded)"} files=${files.length} missing=${byKind("missing")} case=${byKind("case")} other=${r.findings.length - byKind("missing") - byKind("case")}`,
    );
  }

  const camelot = results.filter((r) => r.gameType === "camelot");
  for (const r of camelot) {
    const lua = r.files.filter((f) => f.kind === "lua" && f.exists).length;
    const xml = r.files.filter((f) => f.kind === "xml" && f.exists).length;
    const rootRel = r.files.filter((f) => f.via === "addon-root").length;
    console.log(`\nForever (camelot) summary: TOC ${r.toc ?? "none"}; loads ${lua} Lua and ${xml} XML files; ` + `${rootRel} XML references resolved against the addon root (fallback rule).`);
    for (const f of r.findings) console.log(fmt(f));
  }

  const baseline: BaselineEntry[] = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")).findings : [];
  const { fresh, stale } = compareToBaseline(findings, baseline);
  if (stale.length) {
    console.log(`\n${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} no longer found (fixed?); run with --write-baseline to drop:`);
    for (const s of stale) console.log(`  ${findingKey(s)}`);
  }
  if (fresh.length) {
    console.error(`\nFAIL: ${fresh.length} new finding(s) not in baseline:`);
    for (const g of GAME_TYPES) {
      const fs = fresh.filter((f) => f.gameType === g);
      if (!fs.length) continue;
      console.error(`[${g}]`);
      for (const f of fs) console.error(fmt(f));
    }
    return 1;
  }
  console.log(`\nOK: ${findings.length} finding(s), all in baseline (${baseline.length} entries).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`check-manifests: ${(e as Error).stack ?? e}`);
    process.exitCode = 1;
  }
}

