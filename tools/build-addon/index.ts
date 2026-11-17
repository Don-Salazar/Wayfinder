// build-addon: build the shipped addon folder dist/Wayfinder.
//
// Copies every file that ships (Wayfinder.toc, every file it loads, the extra
// files and asset folders from tools/build-toc/config.json, bundled library
// licences) and applies the rename map rebrand.json to the copied Lua, XML
// and TOC text, so Wayfinder installs next to RestedXP's RXPGuides without
// sharing globals, saved variables, frame names, comm prefixes, macros or
// slash commands. The repo keeps upstream's names, so upstream merges stay
// small. Renames never add or remove lines (checked per file).
//
//   npm run build:addon                      build dist/Wayfinder and print a summary
//   npm run check:addon                      build, then --check-residue and --check-lines
//   tsx tools/build-addon/index.ts --check-residue   fail on RXP/RestedXP residue outside residue-allow.json
//   tsx tools/build-addon/index.ts --check-lines     fail if a dist Lua file's line count differs from its source

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildToc, loadConfig, sameText, shippedFiles, upstreamCommit } from "../build-toc/index.ts";
import { lineCount, Rebrander, type RebrandConfig } from "./rebrand.ts";
import { scanResidue, type Hit, type ResidueConfig } from "./residue.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REBRAND = fileURLToPath(new URL("./rebrand.json", import.meta.url));
const RESIDUE_ALLOW = fileURLToPath(new URL("./residue-allow.json", import.meta.url));
export const DIST = "dist/Wayfinder";

const TEXT_EXT = new Set(["lua", "xml", "toc"]);
const SCAN_EXT = new Set(["lua", "xml", "toc", "md", "txt"]);
const ext = (p: string) => (p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "");

export interface BuildSummary {
  files: number;
  changed: string[];
  counts: Map<string, number>;
}

/** Decode UTF-8 and refuse files that would not survive a decode/encode round trip. */
function readText(path: string, buf: Buffer): string {
  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) throw new Error(`build-addon: ${path} is not valid UTF-8; refusing to rewrite it`);
  return text;
}

export function transform(rb: Rebrander, path: string, text: string): string {
  switch (ext(path)) {
    case "lua":
      return rb.lua(text, path);
    case "xml":
      return rb.xml(text);
    case "toc":
      return rb.toc(text);
    default:
      return text;
  }
}

export function buildAddon(root = REPO_ROOT, outRel = DIST): BuildSummary {
  const tocConfig = loadConfig();
  const built = buildToc(readFileSync(join(root, tocConfig.upstreamToc), "utf8"), tocConfig, upstreamCommit());
  if (!sameText(readFileSync(join(root, tocConfig.output), "utf8"), built.text)) {
    throw new Error(`build-addon: ${tocConfig.output} is stale; run "npm run build:toc" first.`);
  }
  const { files, problems } = shippedFiles(root, tocConfig);
  if (problems.length) throw new Error(`build-addon: ${problems.join("; ")}`);

  const rb = new Rebrander(JSON.parse(readFileSync(REBRAND, "utf8")) as RebrandConfig);
  const out = resolve(root, outRel);
  if (!/[\\/]dist[\\/]Wayfinder$/.test(out)) throw new Error(`build-addon: refusing to write to ${out}`);
  rmSync(out, { recursive: true, force: true });

  const changed: string[] = [];
  for (const f of files) {
    const src = join(root, f);
    const dest = join(out, f);
    mkdirSync(dirname(dest), { recursive: true });
    if (rb.isVerbatim(f) || !TEXT_EXT.has(ext(f))) {
      copyFileSync(src, dest);
      continue;
    }
    const buf = readFileSync(src);
    const text = readText(f, buf);
    const next = transform(rb, f, text);
    if (lineCount(next) !== lineCount(text)) throw new Error(`build-addon: ${f}: line count changed (${lineCount(text)} -> ${lineCount(next)})`);
    if (next === text) copyFileSync(src, dest);
    else {
      writeFileSync(dest, next, "utf8");
      changed.push(f);
    }
  }
  const coll = rb.collisions();
  if (coll.length) throw new Error(`build-addon: renamed string literals would change which lookups match:\n  ${coll.join("\n  ")}`);
  return { files: files.length, changed, counts: rb.counts };
}

export function checkResidue(root = REPO_ROOT, outRel = DIST): { hits: Hit[]; byClass: Map<string, number> } {
  const cfg = JSON.parse(readFileSync(RESIDUE_ALLOW, "utf8")) as ResidueConfig;
  const tocConfig = loadConfig();
  const { files } = shippedFiles(root, tocConfig);
  const hits: Hit[] = [];
  for (const f of files) {
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (!SCAN_EXT.has(ext(f)) && !/^licen[cs]e$/i.test(base)) continue;
    const p = join(root, outRel, f);
    if (!existsSync(p)) throw new Error(`build-addon: ${outRel}/${f} missing; build first`);
    hits.push(...scanResidue(f, readFileSync(p, "utf8"), cfg));
  }
  const byClass = new Map<string, number>();
  for (const h of hits) byClass.set(h.cls ?? "(unclassified)", (byClass.get(h.cls ?? "(unclassified)") ?? 0) + 1);
  return { hits, byClass };
}

export function checkLines(root = REPO_ROOT, outRel = DIST): string[] {
  const { files } = shippedFiles(root, loadConfig());
  const bad: string[] = [];
  for (const f of files) {
    if (ext(f) !== "lua") continue;
    const a = lineCount(readFileSync(join(root, f), "utf8"));
    const b = lineCount(readFileSync(join(root, outRel, f), "utf8"));
    if (a !== b) bad.push(`${f}: ${a} lines in the repo, ${b} in ${outRel}`);
  }
  return bad;
}

function main(argv: string[]): number {
  const s = buildAddon();
  console.log(`build-addon: wrote ${DIST}: ${s.files} files, ${s.changed.length} rewritten by rebrand.json.`);
  const ids = [...s.counts.keys()].sort();
  let total = 0;
  for (const id of ids) {
    console.log(`  ${String(s.counts.get(id)).padStart(6)}  ${id}`);
    total += s.counts.get(id)!;
  }
  console.log(`  ${String(total).padStart(6)}  total replacements`);
  let status = 0;

  if (argv.includes("--check-lines")) {
    const bad = checkLines();
    for (const b of bad) console.error(`LINES: ${b}`);
    if (bad.length) status = 1;
    else console.log(`check-lines: OK (every Lua file in ${DIST} has its source's line count)`);
  }

  if (argv.includes("--check-residue")) {
    const { hits, byClass } = checkResidue();
    console.log("residue by class:");
    for (const [k, v] of [...byClass].sort()) console.log(`  ${String(v).padStart(7)}  ${k}`);
    const bad = hits.filter((h) => !h.cls);
    for (const h of bad) console.error(`RESIDUE: ${DIST}/${h.file}:${h.line}: ${h.text}`);
    if (bad.length) {
      console.error(`check-residue: FAIL, ${bad.length} occurrence(s) outside tools/build-addon/residue-allow.json`);
      status = 1;
    } else console.log(`check-residue: OK (${hits.length} occurrences, all in allowlisted classes)`);
  }
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
