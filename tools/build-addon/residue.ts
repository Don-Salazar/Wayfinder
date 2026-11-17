// Residue check for the built addon: every remaining RXP / RestedXP
// occurrence (case-insensitive) must belong to an allowlisted class in
// residue-allow.json, each with a reason.

import { globToRegExp } from "../lib/files.ts";
import { COMMENT, lexLua, LineIndex, regionsToc, regionsXml, STRING } from "../inventory-ids/lex.ts";

export interface ResidueClass {
  id: string;
  reason: string;
  /** File globs (forward slashes, relative to the addon folder). */
  paths?: string[];
  /** Region of the hit: "comment", "string" (Lua string literal / XML attribute value) or "code". */
  region?: "comment" | "string" | "code";
  /** Regex the enclosing string literal / attribute value content must match. */
  literal?: string;
  /** Regex the hit's line must match. */
  line?: string;
  /** Regex with a match on the hit's line that covers the hit. */
  span?: string;
}

export interface ResidueConfig {
  description?: string;
  classes: ResidueClass[];
}

export interface Hit {
  file: string;
  line: number;
  text: string;
  cls?: string;
}

export const RESIDUE = /rxp|restedxp|rested[ _-]?xp/gi;

interface Compiled {
  c: ResidueClass;
  paths?: RegExp[];
  literal?: RegExp;
  line?: RegExp;
  span?: RegExp;
}

export function validateResidue(cfg: ResidueConfig): void {
  const ids = new Set<string>();
  for (const c of cfg.classes) {
    if (!c.id || ids.has(c.id)) throw new Error(`residue-allow.json: class id "${c.id}" missing or duplicated`);
    if (!c.reason?.trim()) throw new Error(`residue-allow.json: class "${c.id}" needs a reason`);
    if (!c.paths && !c.region && !c.literal && !c.line && !c.span) throw new Error(`residue-allow.json: class "${c.id}" matches everything`);
    ids.add(c.id);
  }
}

function compile(cfg: ResidueConfig): Compiled[] {
  validateResidue(cfg);
  return cfg.classes.map((c) => ({
    c,
    ...(c.paths ? { paths: c.paths.map(globToRegExp) } : {}),
    ...(c.literal ? { literal: new RegExp(c.literal) } : {}),
    ...(c.line ? { line: new RegExp(c.line) } : {}),
    ...(c.span ? { span: new RegExp(c.span, "g") } : {}),
  }));
}

/** Classify every residue hit in one file. */
export function scanResidue(path: string, src: string, cfg: ResidueConfig): Hit[] {
  const classes = compile(cfg);
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  let region: Uint8Array | undefined;
  let literals: [number, number][] = [];
  if (ext === "lua") {
    const lx = lexLua(src);
    region = lx.region;
    literals = lx.tokens.filter((t) => t.type === "string").map((t) => [t.cstart!, t.cend!]);
  } else if (ext === "xml") {
    region = regionsXml(src);
    let i = 0;
    while (i < src.length) {
      if (region[i] === STRING) {
        let j = i;
        while (j < src.length && region[j] === STRING) j++;
        literals.push([i + 1, j - 1]);
        i = j;
      } else i++;
    }
  } else if (ext === "toc") region = regionsToc(src);

  const lines = new LineIndex(src);
  const hits: Hit[] = [];
  RESIDUE.lastIndex = 0;
  for (let m = RESIDUE.exec(src); m; m = RESIDUE.exec(src)) {
    const off = m.index;
    const r = region ? region[off] : undefined;
    const regionName = r === COMMENT ? "comment" : r === STRING ? "string" : "code";
    const lit = findLiteral(literals, off);
    const literal = lit ? src.slice(lit[0], lit[1]) : undefined;
    const lineNo = lines.line(off);
    const ls = src.lastIndexOf("\n", off - 1) + 1;
    let le = src.indexOf("\n", off);
    if (le < 0) le = src.length;
    const lineText = src.slice(ls, le).replace(/\r$/, "");
    const col = off - ls;
    let cls: string | undefined;
    for (const k of classes) {
      if (k.paths && !k.paths.some((re) => re.test(path))) continue;
      if (k.c.region && (region ? k.c.region !== regionName : true)) continue;
      if (k.literal && (literal === undefined || !k.literal.test(literal))) continue;
      if (k.line && !k.line.test(lineText)) continue;
      if (k.span && !covers(k.span, lineText, col)) continue;
      cls = k.c.id;
      break;
    }
    hits.push({ file: path, line: lineNo, text: lines.text(off), ...(cls ? { cls } : {}) });
  }
  return hits;
}

function findLiteral(lits: [number, number][], off: number): [number, number] | undefined {
  let lo = 0;
  let hi = lits.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = lits[mid]!;
    if (off < s) hi = mid - 1;
    else if (off >= e) lo = mid + 1;
    else return lits[mid];
  }
  return undefined;
}

function covers(re: RegExp, line: string, col: number): boolean {
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index <= col && col < m.index + Math.max(1, m[0].length)) return true;
    if (m[0].length === 0) re.lastIndex++;
  }
  return false;
}
