// build-toc: generate Wayfinder.toc from upstream's RXPGuides.toc.
//
// We never hand-edit upstream's TOC (it would conflict on every upstream
// sync). Instead this tool keeps, in order, the file lines of RXPGuides.toc
// that load for one game type (camelot = WoW: Forever), writes them without
// their [AllowLoadGameType ...] tag, removes the lines listed under "drop" in
// config.json, and puts our own header on top.
//
//   npm run build:toc                 write Wayfinder.toc
//   npm run check:toc                 exit 1 if Wayfinder.toc on disk is stale
//   tsx tools/build-toc/index.ts --list-files
//                                     print every file the addon ships
//                                     (used by tools/dev/install.ps1)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath } from "../lib/files.ts";
import { canonicalGameType, FileIndex, GAME_TYPES, lineApplies, loadOrder, parseToc, type GameType } from "../check-manifests/manifest.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CONFIG = fileURLToPath(new URL("./config.json", import.meta.url));
const ORIGINS = fileURLToPath(new URL("../check-origins/origins.json", import.meta.url));

export const INHERIT = "inherit";

export interface DropEntry {
  path: string;
  reason: string;
}

export interface TocConfig {
  upstreamToc: string;
  output: string;
  addon: string;
  gameType: GameType;
  header: Record<string, string>;
  drop: DropEntry[];
  ship: { extraFiles: string[]; assetDirs: string[] };
}

/** Comparison key for TOC paths: case-insensitive, "\" and "/" equal. */
export function pathKey(p: string): string {
  return (normalizePath(p) ?? p.replace(/\\/g, "/")).toLowerCase();
}

export function validateConfig(c: TocConfig): void {
  const err = (m: string) => {
    throw new Error(`build-toc config: ${m}`);
  };
  for (const k of ["upstreamToc", "output", "addon"] as const) if (typeof c[k] !== "string" || !c[k]) err(`"${k}" must be a non-empty string`);
  if (!(GAME_TYPES as readonly string[]).includes(c.gameType)) err(`unknown gameType "${c.gameType}"`);
  if (`${c.addon}.toc`.toLowerCase() !== c.output.toLowerCase()) err(`output "${c.output}" must be "<addon>.toc" (the client reads the TOC named after the folder)`);
  if (!c.header || typeof c.header !== "object") err(`"header" must be an object`);
  if (!("Interface" in c.header)) err(`header must set "Interface"`);
  for (const [k, v] of Object.entries(c.header)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(k)) err(`header key "${k}" is not a plain TOC key`);
    if (/^X-/i.test(k)) err(`header key "${k}": X- lines are not carried over`);
    if (/^Interface-/i.test(k)) err(`header key "${k}": per-flavour Interface lines are not carried over`);
    if (typeof v !== "string" || !v.trim() || /[\r\n]/.test(v)) err(`header "${k}" must be a one-line, non-empty string`);
  }
  if (!Array.isArray(c.drop)) err(`"drop" must be an array`);
  const seen = new Set<string>();
  for (const d of c.drop) {
    if (!d || typeof d.path !== "string" || !d.path.trim()) err(`every drop entry needs a "path"`);
    if (typeof d.reason !== "string" || !d.reason.trim()) err(`drop "${d.path}" needs a non-empty "reason"`);
    const key = pathKey(d.path);
    if (seen.has(key)) err(`drop "${d.path}" is listed twice`);
    seen.add(key);
  }
  if (!c.ship || !Array.isArray(c.ship.extraFiles) || !Array.isArray(c.ship.assetDirs)) err(`"ship" needs "extraFiles" and "assetDirs" arrays`);
}

export function loadConfig(path = CONFIG): TocConfig {
  const c = JSON.parse(readFileSync(path, "utf8")) as TocConfig;
  validateConfig(c);
  return c;
}

/** Upstream commit we are based on (tools/check-origins/origins.json). */
export function upstreamCommit(path = ORIGINS): string {
  const sha = (JSON.parse(readFileSync(path, "utf8")) as { upstreamCommit?: string }).upstreamCommit;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`build-toc: no 40-hex upstreamCommit in ${path}`);
  return sha;
}

export interface BuildResult {
  text: string;
  /** File lines written, in order. */
  files: string[];
  dropped: DropEntry[];
}

const STRIPPABLE = new Set(["allowloadgametype", "excludeloadgametype"]);

/**
 * Build the TOC text. Throws if a drop entry matches no kept line, if an
 * inherited header key is missing upstream, or if a kept line carries a
 * directive whose meaning would change when the tag is removed.
 */
export function buildToc(upstreamText: string, config: TocConfig, commit: string): BuildResult {
  const upstream = parseToc(upstreamText.replace(/^﻿/, ""));
  const meta = new Map([...upstream.metadata].map(([k, v]) => [k.toLowerCase(), v]));

  const header: string[] = [];
  for (const [k, v] of Object.entries(config.header)) {
    if (v === INHERIT) {
      const up = meta.get(k.toLowerCase());
      if (up === undefined) throw new Error(`build-toc: header "${k}" is "inherit" but ${config.upstreamToc} has no "## ${k}" line`);
      header.push(`## ${k}: ${up}`);
    } else header.push(`## ${k}: ${v}`);
  }

  const drops = new Map(config.drop.map((d) => [pathKey(d.path), { entry: d, used: false }]));
  const files: string[] = [];
  const dropped: DropEntry[] = [];
  for (const l of upstream.files) {
    if (l.unknown.length) throw new Error(`build-toc: ${config.upstreamToc}:${l.line} has unknown bracket token(s) ${l.unknown.join(" ")}`);
    for (const d of l.directives) {
      if (!STRIPPABLE.has(d.name)) throw new Error(`build-toc: ${config.upstreamToc}:${l.line} uses [${d.name}]; removing it would change its meaning`);
      if (d.name === "allowloadgametype") {
        const known = (d.value ?? "").split(",").filter((v) => v.trim() && canonicalGameType(v));
        if (!known.length) throw new Error(`build-toc: ${config.upstreamToc}:${l.line} [AllowLoadGameType ${d.value ?? ""}] names no known game type (ambiguous)`);
      }
    }
    if (!lineApplies(l.directives, config.gameType)) continue;
    const d = drops.get(pathKey(l.path));
    if (d) {
      d.used = true;
      dropped.push(d.entry);
      continue;
    }
    files.push(l.path);
  }
  const stale = [...drops.values()].filter((d) => !d.used).map((d) => d.entry.path);
  if (stale.length) throw new Error(`build-toc: drop entr${stale.length === 1 ? "y matches" : "ies match"} no ${config.gameType} line of ${config.upstreamToc} (stale after an upstream sync?): ${stale.join(", ")}`);

  const comment =
    `# GENERATED FILE - do not edit. Built by tools/build-toc from ${config.upstreamToc} ` +
    `(RestedXP upstream commit ${commit}). Edit tools/build-toc/config.json and run "npm run build:toc".`;
  const text = [comment, ...header, "", ...files, ""].join("\n");
  return { text, files, dropped };
}

/** Same content regardless of line endings (git autocrlf may rewrite them on checkout). */
export function sameText(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  return n(a) === n(b);
}

const LICENCE_FILE = /^(licen[cs]e|copying)(\.[a-z]+)?$/i;

/**
 * Every file the addon ships: the generated TOC, every file it loads (TOC and
 * XML expansion), the extra files and asset folders from config, and licence
 * files that sit in a folder we ship code from (bundled libraries).
 */
export function shippedFiles(root: string, config: TocConfig, index = FileIndex.fromDisk(root)): { files: string[]; problems: string[] } {
  const problems: string[] = [];
  const out = new Set<string>();
  const r = loadOrder(config.gameType, { root, index, addon: config.addon });
  if (r.toc?.toLowerCase() !== config.output.toLowerCase()) problems.push(`the client would load ${r.toc ?? "no TOC"}, not ${config.output}`);
  for (const f of r.files) {
    if (f.exists) out.add(f.path);
    else problems.push(`${f.from}:${f.line} loads missing file ${f.path}`);
  }
  for (const e of config.ship.extraFiles) {
    const hit = index.find(e);
    if (hit) out.add(hit);
    else problems.push(`extra file ${e} not found`);
  }
  for (const dir of config.ship.assetDirs) {
    const prefix = `${dir.replace(/\\/g, "/").replace(/\/$/, "")}/`.toLowerCase();
    const hits = [...index.exact].filter((p) => p.toLowerCase().startsWith(prefix));
    if (!hits.length) problems.push(`asset folder ${dir} is empty or missing`);
    for (const p of hits) out.add(p);
  }
  const dirs = new Set([...out].map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")).filter(Boolean));
  for (const p of index.exact) {
    const slash = p.lastIndexOf("/");
    if (slash > 0 && dirs.has(p.slice(0, slash)) && LICENCE_FILE.test(p.slice(slash + 1))) out.add(p);
  }
  return { files: [...out].sort(), problems };
}

function main(argv: string[]): number {
  const config = loadConfig();
  const outPath = join(REPO_ROOT, config.output);

  if (argv.includes("--list-files")) {
    const { files, problems } = shippedFiles(REPO_ROOT, config);
    if (problems.length) {
      for (const p of problems) console.error(`build-toc: ${p}`);
      return 1;
    }
    for (const f of files) console.log(f);
    return 0;
  }

  const upstreamText = readFileSync(join(REPO_ROOT, config.upstreamToc), "utf8");
  const built = buildToc(upstreamText, config, upstreamCommit());

  if (argv.includes("--check")) {
    if (!existsSync(outPath)) {
      console.error(`FAIL: ${config.output} does not exist. Run "npm run build:toc".`);
      return 1;
    }
    if (!sameText(readFileSync(outPath, "utf8"), built.text)) {
      console.error(`FAIL: ${config.output} differs from what tools/build-toc would generate. Run "npm run build:toc" (and do not edit ${config.output} by hand).`);
      return 1;
    }
    console.log(`OK: ${config.output} is up to date (${built.files.length} file lines, ${built.dropped.length} dropped).`);
    return 0;
  }

  writeFileSync(outPath, built.text);
  console.log(`wrote ${config.output}: ${built.files.length} file lines for ${config.gameType} from ${config.upstreamToc}, ${built.dropped.length} dropped.`);
  for (const d of built.dropped) console.log(`  dropped ${d.path}  (${d.reason})`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
