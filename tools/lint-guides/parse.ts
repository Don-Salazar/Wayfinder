// Guide extraction and parsing for lint-guides.
//
// A guide is the string argument of `RXPGuides.RegisterGuide(...)` in a Lua
// file. This module finds those calls with the Lua tokenizer, then splits the
// guide text into header lines and steps the way the engine does, keeping the
// line number in the FILE for every guide line.
//
// Engine rules mirrored here (GuideLoader.lua in this checkout):
// - RegisterGuide(groupOrContent, text): with a second string argument the
//   first is the group and the header pre-scan is skipped (:372-389, :440).
// - Comments: "--" to end of line is removed, but only when a line break
//   follows (`%-%-[^\r\n]*[\r\n]+`, :751; two-argument form :779).
// - Lines are visited with `[^\n\r]+` and trimmed (:803-806).
// - A step starts at a line whose first four characters are "step" (:808);
//   its condition is `line:match("<<%s*(.+)")` (:840).
// - Header lines: `(.-)%s*<<%s*(.+)` splits a condition off; nothing before
//   "<<" makes it the guide's bare condition (:863-873); then
//   `^#(%S+)%s*(=?)%s*(.*)` is a tag (:876).
// - Step lines (parseLine, :622-732): `%s*<<%s*(.+)` condition first (:636),
//   then `^#(%S+)` step tag (:643), then `%s*>>%s*(.*)` display text (:658),
//   then `^%.(%S+)%s*(.*)` element function (:663).

import { COMMENT, LineIndex, lexLua } from "../inventory-ids/lex.ts";

export interface GuideLine {
  /** 1-based line in the file. */
  line: number;
  /** Raw line text (before comment stripping), untrimmed. */
  raw: string;
  /** After comment stripping and trimming (what the engine sees). */
  text: string;
  /** Column (0-based, in raw) where the engine's comment strip cut the line, if it did. */
  cut?: number;
}

export interface HeaderTag {
  tag: string;
  value: string;
  assignment: boolean;
  /** Condition from `#tag value << cond`, if any. */
  cond?: string;
  line: GuideLine;
}

export interface BodyLine {
  line: GuideLine;
  cond?: string;
  stepTag?: { tag: string; value: string; assignment: boolean };
  /** Display text after ">>" (undefined when there is no ">>"). */
  displayText?: string;
  command?: { name: string; args: string };
}

export interface Step {
  line: GuideLine;
  cond?: string;
  body: BodyLine[];
}

export interface Guide {
  file: string;
  /** 0-based index of the RegisterGuide call in the file. */
  index: number;
  /** File line of the RegisterGuide call. */
  callLine: number;
  twoArg: boolean;
  /** Group passed as first argument in the two-argument form. */
  groupArg?: string;
  /** Code (comments blanked) that precedes this call in the file: file-level guards. */
  prelude: string;
  /** All guide lines, raw and stripped, in order (non-empty after stripping). */
  lines: GuideLine[];
  /** Every raw line, including ones that are empty after stripping (for the "--" check). */
  rawLines: GuideLine[];
  headerTags: HeaderTag[];
  /** Bare `<< cond` header lines, in order. */
  bareConds: { cond: string; line: GuideLine }[];
  /** Header lines before the first step, as the pre-scan sees them (comment stripped unconditionally). */
  prescanHeader: GuideLine[] | null;
  steps: Step[];
}

/** Lua `tonumber` on a string (decimal, hex, exponent; surrounding whitespace allowed). */
export function luaToNumber(s: string): number | undefined {
  if (/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(s)) return Number(s.trim());
  if (/^\s*[-+]?0[xX][0-9a-fA-F]+\s*$/.test(s)) {
    const t = s.trim();
    const neg = t.startsWith("-");
    const v = parseInt(t.replace(/^[-+]/, ""), 16);
    return neg ? -v : v;
  }
  return undefined;
}

/** Find every `RXPGuides.RegisterGuide(<string>[, <string>])` call in Lua source. */
export function extractGuides(file: string, src: string): Guide[] {
  const { tokens, region } = lexLua(src);
  const li = new LineIndex(src);
  const out: Guide[] = [];
  for (let i = 0; i + 4 < tokens.length; i++) {
    const t = tokens;
    if (!(t[i]!.type === "name" && t[i]!.value === "RXPGuides" && t[i + 1]!.value === "." && t[i + 2]!.value === "RegisterGuide" && t[i + 3]!.value === "(")) continue;
    // Not `x.RXPGuides.RegisterGuide` from another table: accept `_G.RXPGuides` too.
    const a1 = t[i + 4]!;
    if (a1.type !== "string") continue;
    let content = a1;
    let groupArg: string | undefined;
    let twoArg = false;
    if (t[i + 5]?.value === "," && t[i + 6]?.type === "string") {
      twoArg = true;
      groupArg = src.slice(a1.cstart!, a1.cend!);
      content = t[i + 6]!;
    }
    let prelude = "";
    for (let k = 0; k < t[i]!.start; k++) prelude += region[k] === COMMENT ? " " : src[k];
    out.push(parseGuideText(file, out.length, src, content.cstart!, content.cend!, li, { twoArg, prelude, callLine: li.line(t[i]!.start), ...(groupArg !== undefined ? { groupArg } : {}) }));
  }
  return out;
}

/**
 * Parse guide text src[start:end] (the long-string content). `li` maps file
 * offsets to lines. Exported for tests (fixtures can pass a whole string).
 */
export function parseGuideText(
  file: string,
  index: number,
  src: string,
  start: number,
  end: number,
  li: LineIndex = new LineIndex(src),
  opts: { twoArg?: boolean; groupArg?: string; prelude?: string; callLine?: number } = {},
): Guide {
  const rawLines: GuideLine[] = [];
  const lines: GuideLine[] = [];
  let pos = start;
  while (pos <= end) {
    let e = pos;
    while (e < end && src[e] !== "\n" && src[e] !== "\r") e++;
    const raw = src.slice(pos, e);
    const hasBreak = e < end; // a line break follows inside the guide text
    let stripped = raw;
    const c = raw.indexOf("--");
    const cut = c >= 0 && hasBreak;
    if (cut) stripped = raw.slice(0, c);
    const gl: GuideLine = { line: li.line(pos), raw, text: stripped.trim(), ...(cut ? { cut: c } : {}) };
    rawLines.push(gl);
    // The engine visits `[^\n\r]+` runs; a whitespace-only line is visited but ignored.
    if (gl.text !== "") lines.push(gl);
    if (e >= end) break;
    pos = e + (src[e] === "\r" && src[e + 1] === "\n" ? 2 : 1);
  }

  const guide: Guide = {
    file,
    index,
    callLine: opts.callLine ?? (rawLines[0]?.line ?? 1),
    twoArg: !!opts.twoArg,
    ...(opts.groupArg !== undefined ? { groupArg: opts.groupArg } : {}),
    prelude: opts.prelude ?? "",
    lines,
    rawLines,
    headerTags: [],
    bareConds: [],
    prescanHeader: null,
    steps: [],
  };

  // Pre-scan view (LoadGuide :442-470): text up to the first `[\r\n]%s*step`,
  // each line with `%-%-.*$` removed unconditionally.
  const firstStepRaw = rawLines.findIndex((l, k) => k > 0 && /^\s*step/.test(l.raw));
  if (firstStepRaw > 0) guide.prescanHeader = rawLines.slice(0, firstStepRaw).map((l) => ({ ...l, text: l.raw.replace(/--.*$/, "") }));

  let step: Step | null = null;
  for (const gl of lines) {
    const line = gl.text;
    if (line.slice(0, 4) === "step") {
      const m = /<<\s*(.+)/.exec(line);
      step = { line: gl, body: [], ...(m ? { cond: m[1]! } : {}) };
      guide.steps.push(step);
      continue;
    }
    if (!step) {
      // header line
      let code = line;
      let cond: string | undefined;
      const m = /^(.*?)\s*<<\s*(.+)$/.exec(line);
      if (m) {
        code = m[1]!;
        cond = m[2]!;
        if (code.length === 0) {
          guide.bareConds.push({ cond, line: gl });
          continue;
        }
      }
      const t = /^#(\S+)\s*(=?)\s*(.*)$/.exec(code);
      if (t) guide.headerTags.push({ tag: t[1]!, value: t[3]!, assignment: t[2] === "=", line: gl, ...(cond !== undefined ? { cond } : {}) });
      continue;
    }
    // step body line (parseLine)
    const bl: BodyLine = { line: gl };
    let rest = line;
    const cm = /\s*<<\s*(.+)$/.exec(rest);
    if (cm) {
      bl.cond = cm[1]!;
      rest = rest.slice(0, cm.index);
    }
    const st = /^#(\S+)\s*(=?)\s*(.*)$/.exec(rest);
    if (st) {
      bl.stepTag = { tag: st[1]!, value: st[3]!, assignment: st[2] === "=" };
      step.body.push(bl);
      continue;
    }
    const dm = /\s*>>\s*(.*)$/.exec(rest);
    if (dm) {
      bl.displayText = dm[1]!;
      rest = rest.slice(0, dm.index);
    }
    const fm = /^\.(\S+)\s*(.*)$/.exec(rest);
    if (fm) bl.command = { name: fm[1]!, args: fm[2]! };
    step.body.push(bl);
  }
  return guide;
}

/** Split element arguments the way parseLine does by default: trim around commas, drop empty fields. */
export function splitArgs(args: string): string[] {
  return args.replace(/\s*,\s*/g, ",").split(",").filter((a) => a.length > 0);
}

/** Zero-pad a leading single-digit range: "1-6 X" -> "01-06 X" (addon.affix, GuideLoader.lua:108-111, :938). */
export function padName(name: string): string {
  return name.replace(/^(\d)-(\d\d?)/, (_m, a: string, b: string) => `0${a}-${b.length === 1 ? "0" + b : b}`);
}

/** First name of the guide (the first `#name` header line), or undefined. */
export function guideName(g: Guide): string | undefined {
  return g.headerTags.find((t) => t.tag === "name")?.value;
}

/** Display label for findings: the first #name, else "(unnamed #k)". */
export function guideLabel(g: Guide): string {
  return guideName(g) ?? `(unnamed #${g.index + 1})`;
}
