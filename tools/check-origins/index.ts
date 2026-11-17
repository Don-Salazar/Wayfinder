// check-origins: licence/origin gate (PIPELINE P0, CLAUDE.md "No GPL data").
//
// 1. Every file (tracked, plus untracked-but-not-ignored) must either exist at
//    the same path in upstream RXPGuides at `upstreamCommit`, or match an
//    "ours" glob in origins.json. Unknown tracked files fail; unknown
//    untracked files are warnings (classify them before committing).
// 2. Every file that is not byte-identical to its upstream version and is not
//    excluded (docs/**) is scanned for forbidden-source markers (Questie data,
//    MaNGOS-family datasets, SimGearForever, GPL text). Any hit fails, unless
//    the file is allowlisted in origins.json with a reason.
//
//   npm run check:origins

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp } from "../lib/files.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CONFIG = fileURLToPath(new URL("./origins.json", import.meta.url));

export interface OriginsConfig {
  upstreamCommit: string;
  ours: { glob: string; origin: string; licence: string }[];
  markerScan: {
    exclude: string[];
    markers: { id: string; regex: string }[];
    allow: { path: string; reason: string }[];
  };
}

export interface Classified {
  path: string;
  tracked: boolean;
  origin: "upstream" | "ours" | "unknown";
  label?: string;
}

export interface MarkerHit {
  path: string;
  line: number;
  marker: string;
  text: string;
}

export function validateConfig(c: OriginsConfig): void {
  if (!/^[0-9a-f]{40}$/.test(c.upstreamCommit)) throw new Error("origins.json: upstreamCommit must be a full 40-hex SHA");
  for (const o of c.ours) if (!o.glob || !o.origin || !o.licence) throw new Error(`origins.json: ours entry ${JSON.stringify(o)} needs glob, origin and licence`);
  for (const a of c.markerScan.allow) if (!a.path || !a.reason?.trim()) throw new Error(`origins.json: allow entry ${JSON.stringify(a)} needs a path and a written reason`);
  for (const m of c.markerScan.markers) new RegExp(m.regex, "i"); // throws on a bad pattern
}

export function classify(
  files: { path: string; tracked: boolean }[],
  upstream: ReadonlySet<string>,
  ours: OriginsConfig["ours"],
): Classified[] {
  const compiled = ours.map((o) => ({ re: globToRegExp(o.glob), o }));
  return files.map((f) => {
    if (upstream.has(f.path)) return { ...f, origin: "upstream" as const, label: "RXPGuides upstream" };
    const hit = compiled.find((c) => c.re.test(f.path));
    return hit ? { ...f, origin: "ours" as const, label: `${hit.o.origin} (${hit.o.glob})` } : { ...f, origin: "unknown" as const };
  });
}

export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function scanText(path: string, text: string, markers: OriginsConfig["markerScan"]["markers"]): MarkerHit[] {
  const compiled = markers.map((m) => ({ id: m.id, re: new RegExp(m.regex, "i") }));
  const hits: MarkerHit[] = [];
  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    for (const m of compiled) if (m.re.test(line)) hits.push({ path, line: i + 1, marker: m.id, text: line.trim().slice(0, 160) });
  });
  return hits;
}

function git(args: string[], input?: string): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });
}

function zList(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

function main(): number {
  const config: OriginsConfig = JSON.parse(readFileSync(CONFIG, "utf8"));
  validateConfig(config);
  const commit = config.upstreamCommit;
  try {
    git(["cat-file", "-e", `${commit}^{commit}`]);
  } catch {
    console.error(`check-origins: upstream commit ${commit} is not available. CI must check out full history (actions/checkout fetch-depth: 0).`);
    return 1;
  }

  // Upstream tree: path -> blob sha.
  const upstreamBlobs = new Map<string, string>();
  for (const entry of zList(git(["ls-tree", "-r", "-z", commit]))) {
    const tab = entry.indexOf("\t");
    const [, type, sha] = entry.slice(0, tab).split(" ");
    if (type === "blob" && sha) upstreamBlobs.set(entry.slice(tab + 1), sha);
  }

  const tracked = zList(git(["ls-files", "-z"]));
  const untracked = zList(git(["ls-files", "-z", "--others", "--exclude-standard"]));
  const files = [...tracked.map((p) => ({ path: p, tracked: true })), ...untracked.map((p) => ({ path: p, tracked: false }))].filter((f) =>
    existsSync(join(REPO_ROOT, f.path)),
  );
  const classified = classify(files, new Set(upstreamBlobs.keys()), config.ours);

  // Identical to upstream? Let git compare the working tree with the upstream
  // commit (same rules as `git status`, so autocrlf checkouts and blobs that
  // were committed with CRLF are handled). Untracked files at an upstream path
  // are treated as changed.
  const changed = new Set(zList(git(["diff", "--name-only", "-z", "--no-renames", commit, "--"])));
  const inUpstream = classified.filter((c) => c.origin === "upstream").map((c) => c.path);
  const trackedSet = new Set(tracked);
  const identical = new Set(inUpstream.filter((p) => trackedSet.has(p) && !changed.has(p)));

  const exclude = config.markerScan.exclude.map(globToRegExp);
  const allow = new Map(config.markerScan.allow.map((a) => [a.path, a.reason]));
  const hits: MarkerHit[] = [];
  const allowedHits: MarkerHit[] = [];
  let scanned = 0;
  for (const c of classified) {
    if (identical.has(c.path) || exclude.some((re) => re.test(c.path))) continue;
    const buf = readFileSync(join(REPO_ROOT, c.path));
    if (isBinary(buf)) continue;
    scanned++;
    const found = scanText(c.path, buf.toString("utf8"), config.markerScan.markers);
    (allow.has(c.path) ? allowedHits : hits).push(...found);
  }

  const count = (o: Classified["origin"], t: boolean) => classified.filter((c) => c.origin === o && c.tracked === t).length;
  console.log(`upstream ${commit.slice(0, 8)}: ${upstreamBlobs.size} files`);
  console.log(`tracked:   ${count("upstream", true)} upstream, ${count("ours", true)} ours, ${count("unknown", true)} unknown`);
  console.log(`untracked: ${count("upstream", false)} upstream, ${count("ours", false)} ours, ${count("unknown", false)} unknown`);
  const modified = inUpstream.filter((p) => !identical.has(p));
  console.log(`upstream paths modified locally: ${modified.length}${modified.length ? " (" + modified.join(", ") + ")" : ""}`);
  console.log(`marker scan: ${scanned} text files scanned; ${allowedHits.length} hit(s) in allowlisted files`);
  for (const [path, reason] of allow) if (allowedHits.some((h) => h.path === path)) console.log(`  allowlisted ${path}: ${reason}`);

  const unknownUntracked = classified.filter((c) => c.origin === "unknown" && !c.tracked);
  if (unknownUntracked.length) {
    console.warn(`\nWARNING: ${unknownUntracked.length} untracked file(s) have no known origin; add an "ours" glob or remove them before committing:`);
    for (const c of unknownUntracked) console.warn(`  ${c.path}`);
  }

  let failed = false;
  const unknownTracked = classified.filter((c) => c.origin === "unknown" && c.tracked);
  if (unknownTracked.length) {
    failed = true;
    console.error(`\nFAIL: ${unknownTracked.length} tracked file(s) with no known origin (not in upstream ${commit.slice(0, 8)}, no "ours" glob):`);
    for (const c of unknownTracked) console.error(`  ${c.path}`);
  }
  if (hits.length) {
    failed = true;
    console.error(`\nFAIL: ${hits.length} forbidden-source marker(s) in files that differ from upstream:`);
    for (const h of hits) console.error(`  ${h.path}:${h.line}  [${h.marker}]  ${h.text}`);
  }
  if (!failed) console.log("\nOK: every file has a known origin; no forbidden-source markers.");
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`check-origins: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
