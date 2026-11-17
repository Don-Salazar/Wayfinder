// lint-guides: check guide text (the RegisterGuide([[ … ]]) DSL) for mistakes
// the engine ignores silently: unknown #tags and .commands, guides that cannot
// load on Forever, dead #next links, malformed << conditions, malformed .goto
// arguments, and "--" cutting display text. See rules.ts for each rule and
// the engine lines it mirrors.
//
// Files checked: every Lua file under Guides/ or lang/Guides-*/ that the
// generated Wayfinder.toc loads for its game type (camelot), plus every Lua
// file under Guides/wf/ (strict: header comment required, zero findings).
//
//   npm run lint:guides                       gate against baseline.json
//   npm run lint:guides -- --summary          counts by kind and token
//   npm run lint:guides -- --json <path>      write all findings as JSON
//   npm run lint:guides -- --write-baseline   accept current upstream findings
//
// Gate (exit 0): no finding in Guides/wf/, and no upstream finding beyond the
// baseline (key: file|guide|kind|token with a count, so line shifts do not
// matter). Baseline entries no longer found are reported but do not fail.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../build-toc/index.ts";
import { loadOrder } from "../check-manifests/manifest.ts";
import { listFiles } from "../lib/files.ts";
import { extractGuides, type Guide } from "./parse.ts";
import { checkWfHeader, crossGuide, foreverAcceptance, KINDS, lintGuide, type Finding, type Kind, type Vocab } from "./rules.ts";
import { classesAndRacesFrom, extractCommands, gamesFrom, loadTags, localesFrom, type CommandDef } from "./vocab.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BASELINE = fileURLToPath(new URL("./baseline.json", import.meta.url));
export const WF_DIR = "Guides/wf/";

export const isGuideFile = (p: string) => /^(Guides\/|lang\/Guides-[^/]+\/)/i.test(p) && /\.lua$/i.test(p);
export const isWf = (p: string) => p.toLowerCase().startsWith(WF_DIR.toLowerCase());

export interface BaselineEntry {
  file: string;
  guide: string;
  kind: Kind;
  token: string;
  count: number;
  /** Example message (informational). */
  note?: string;
}

export function findingKey(f: { file: string; guide: string; kind: string; token: string }): string {
  return `${f.file}|${f.guide}|${f.kind}|${f.token}`;
}

/** Compare current findings with the baseline: new findings (beyond the baseline count) and stale keys. */
export function compareToBaseline(findings: Finding[], baseline: BaselineEntry[]): { fresh: Finding[]; stale: { entry: BaselineEntry; found: number }[] } {
  const allowed = new Map(baseline.map((b) => [findingKey(b), b.count]));
  const seen = new Map<string, number>();
  const fresh: Finding[] = [];
  for (const f of findings) {
    const k = findingKey(f);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > (allowed.get(k) ?? 0)) fresh.push(f);
  }
  const stale = baseline.filter((b) => (seen.get(findingKey(b)) ?? 0) < b.count).map((entry) => ({ entry, found: seen.get(findingKey(entry)) ?? 0 }));
  return { fresh, stale };
}

export function toBaseline(findings: Finding[]): BaselineEntry[] {
  const m = new Map<string, BaselineEntry>();
  for (const f of findings) {
    const k = findingKey(f);
    const e = m.get(k);
    if (e) e.count++;
    else m.set(k, { file: f.file, guide: f.guide, kind: f.kind, token: f.token, count: 1, note: f.message });
  }
  return [...m.values()].sort((a, b) => findingKey(a).localeCompare(findingKey(b)));
}

export interface Analysis {
  guideFiles: string[];
  wfFiles: string[];
  guides: Guide[];
  loaded: Guide[];
  findings: Finding[];
  vocab: Vocab;
  commandDefs: CommandDef[];
}

export function analyze(root: string): Analysis {
  const cfg = loadConfig();
  const r = loadOrder(cfg.gameType, { root, addon: cfg.addon });
  if (!r.toc) throw new Error(`${cfg.output} not found; run "npm run build:toc"`);
  const lua = r.files.filter((f) => f.kind === "lua" && f.exists).map((f) => f.path);
  const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/^﻿/, "");

  // Vocabularies from source.
  const commandDefs = lua.filter((p) => !isGuideFile(p)).flatMap((p) => extractCommands(p, read(p)));
  const findLoaded = (re: RegExp) => {
    const p = lua.find((x) => re.test(x));
    if (!p) throw new Error(`no loaded file matches ${re}`);
    return read(p);
  };
  const cr = classesAndRacesFrom(findLoaded(/^DB\/forever\/spells\.lua$/i));
  const core = findLoaded(/^RXPGuides\.lua$/i);
  const tags = loadTags();
  const vocab: Vocab = {
    headerTags: new Set(tags.headerTags.map((t) => t.tag)),
    stepTags: new Set(tags.stepTags.map((t) => t.tag)),
    commands: new Set(commandDefs.map((c) => c.name)),
    cond: {
      classes: new Set(cr.classes),
      races: new Set(cr.races),
      games: new Set(gamesFrom(core)),
      locales: new Set(localesFrom(core)),
      extras: new Set(tags.conditionExtras.map((e) => e.token)),
    },
  };
  for (const [name, set] of [["commands", vocab.commands], ["classes", vocab.cond.classes], ["races", vocab.cond.races], ["games", vocab.cond.games], ["locales", vocab.cond.locales]] as const) {
    if (!set.size) throw new Error(`vocabulary "${name}" extracted from source is empty; the source layout changed`);
  }

  const guideFiles = lua.filter(isGuideFile);
  const wfDir = join(root, WF_DIR);
  const wfFiles = existsSync(wfDir) ? listFiles(wfDir).filter((p) => /\.lua$/i.test(p)).map((p) => WF_DIR + p) : [];
  const files = [...guideFiles, ...wfFiles.filter((w) => !guideFiles.some((g) => g.toLowerCase() === w.toLowerCase()))];

  const r2 = lintSources(files.map((path) => ({ path, src: read(path) })), vocab);
  return { guideFiles, wfFiles, ...r2, vocab, commandDefs };
}

/** Lint guide files given as text, in load order. */
export function lintSources(files: { path: string; src: string }[], vocab: Vocab): { guides: Guide[]; loaded: Guide[]; findings: Finding[] } {
  const guides: Guide[] = [];
  const findings: Finding[] = [];
  for (const { path, src } of files) {
    if (isWf(path)) findings.push(...checkWfHeader(path, src));
    for (const g of extractGuides(path, src)) {
      guides.push(g);
      findings.push(...lintGuide(g, vocab));
    }
  }
  const loaded = guides.filter((g) => foreverAcceptance(g).loads && g.headerTags.some((t) => t.tag === "name"));
  findings.push(...crossGuide(loaded));
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind));
  return { guides, loaded, findings };
}

function fmt(f: Finding): string {
  return `${f.file}:${f.line}: [${KINDS[f.kind]} ${f.kind}] ${f.guide ? `(${f.guide}) ` : ""}${f.message}${f.suggestion ? ` (did you mean ${f.suggestion}?)` : ""}`;
}

export function summarize(findings: Finding[]): string {
  const lines: string[] = [];
  const byKind = new Map<Kind, Finding[]>();
  for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
  lines.push(`Findings by kind (${findings.length} total):`);
  for (const k of Object.keys(KINDS) as Kind[]) if (byKind.has(k)) lines.push(`  ${String(KINDS[k]).padStart(1)} ${k.padEnd(20)} ${byKind.get(k)!.length}`);
  for (const k of ["unknown-header-tag", "unknown-step-tag", "unknown-command", "dead-next"] as Kind[]) {
    const fs = byKind.get(k);
    if (!fs) continue;
    const tally = new Map<string, number>();
    for (const f of fs) tally.set(f.token, (tally.get(f.token) ?? 0) + 1);
    lines.push(`\n${k} tokens:`);
    for (const [t, n] of [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      const s = fs.find((f) => f.token === t)?.suggestion;
      lines.push(`  ${String(n).padStart(5)}  ${t}${s ? `  -> ${s}?` : ""}`);
    }
  }
  return lines.join("\n");
}

function main(argv: string[]): number {
  const a = analyze(REPO_ROOT);
  const wf = a.findings.filter((f) => isWf(f.file));
  const upstream = a.findings.filter((f) => !isWf(f.file));
  const v = a.vocab;
  console.log(
    `lint-guides: ${a.guideFiles.length} loaded guide file(s), ${a.wfFiles.length} file(s) in ${WF_DIR}; ${a.guides.length} guides, ${a.loaded.length} load on Forever. ` +
      `Vocabulary: ${v.commands.size} commands (from source), ${v.headerTags.size} header tags, ${v.stepTags.size} step tags, ` +
      `conditions: ${v.cond.classes.size} classes, ${v.cond.races.size} races, ${v.cond.games.size} games, ${v.cond.locales.size} locales, ${v.cond.extras.size} extra.`,
  );

  const jsonIdx = argv.indexOf("--json");
  if (jsonIdx >= 0) {
    const out = argv[jsonIdx + 1];
    if (!out) throw new Error("--json needs a path");
    writeFileSync(resolve(out), JSON.stringify({ findings: a.findings }, null, 2) + "\n");
    console.log(`wrote ${a.findings.length} finding(s) to ${resolve(out)}`);
  }
  if (argv.includes("--summary")) console.log("\n" + summarize(a.findings) + "\n");

  if (argv.includes("--write-baseline")) {
    const entries = toBaseline(upstream);
    writeFileSync(
      BASELINE,
      JSON.stringify(
        {
          description:
            "Known findings in upstream guide files (not ours to fix). Key: file|guide|kind|token; 'count' is how many times it occurs. Guides/wf/ files are never baselined. Regenerate with: npm run lint:guides -- --write-baseline",
          findings: entries,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`wrote ${entries.length} baseline entries (${upstream.length} findings) to ${BASELINE}`);
    if (wf.length) console.error(`note: ${wf.length} finding(s) in ${WF_DIR} are not baselined and still fail the gate.`);
    return 0;
  }

  const baseline: BaselineEntry[] = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as { findings: BaselineEntry[] }).findings : [];
  const { fresh, stale } = compareToBaseline(upstream, baseline);
  let failed = false;
  if (wf.length) {
    console.error(`\nFAIL: ${wf.length} finding(s) in ${WF_DIR} (zero allowed):`);
    for (const f of wf) console.error("  " + fmt(f));
    failed = true;
  }
  if (fresh.length) {
    console.error(`\nFAIL: ${fresh.length} upstream finding(s) not in the baseline:`);
    for (const f of fresh) console.error("  " + fmt(f));
    failed = true;
  }
  if (stale.length) {
    console.warn(`\nnote: ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} stale (fewer occurrences than recorded; prune with --write-baseline):`);
    for (const s of stale) console.warn(`  ${findingKey(s.entry)}  (baseline ${s.entry.count}, found ${s.found})`);
  }
  if (failed) return 1;
  console.log(`OK: ${upstream.length} upstream finding(s), all in the baseline (${baseline.length} entries); ${WF_DIR}: no findings.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`lint-guides: ${(e as Error).stack ?? e}`);
    process.exitCode = 1;
  }
}
