// Lexical helpers for the identifier inventory: a small Lua 5.1 tokenizer and
// region maps (code / string / comment) for Lua, XML and TOC text.
//
// This is not a parser. It knows where strings and comments start and end,
// so a classifier can tell `RXPFrame` the identifier from "RXPFrame" the
// string and from -- RXPFrame in a comment. Everything above token level
// (scopes, statements) is approximated in scan.ts.

export const CODE = 0;
export const STRING = 1;
export const COMMENT = 2;
export type Region = typeof CODE | typeof STRING | typeof COMMENT;

export type TokenType = "name" | "string" | "number" | "op";

export interface Token {
  type: TokenType;
  /** Source text of the token (for strings: including delimiters). */
  value: string;
  start: number;
  end: number;
  /** For strings: offsets of the content between the delimiters. */
  cstart?: number;
  cend?: number;
}

export interface Lexed {
  tokens: Token[];
  /** One entry per source character: CODE, STRING or COMMENT. */
  region: Uint8Array;
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const OPS3 = ["..."];
const OPS2 = ["..", "==", "~=", "<=", ">=", "::", "//", "<<", ">>"];

/** Length of a long bracket opener `[==[` at i, or 0. Returns [totalLen, level]. */
function longOpen(src: string, i: number): [number, number] {
  if (src[i] !== "[") return [0, 0];
  let j = i + 1;
  while (src[j] === "=") j++;
  return src[j] === "[" ? [j - i + 1, j - i - 1] : [0, 0];
}

/** Tokenize Lua 5.1 source. Unterminated strings/comments run to end of line/file. */
export function lexLua(src: string): Lexed {
  const n = src.length;
  const region = new Uint8Array(n);
  const tokens: Token[] = [];
  let i = 0;
  const mark = (a: number, b: number, r: Region) => region.fill(r, a, b);
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    // comments
    if (c === "-" && src[i + 1] === "-") {
      const [len, level] = longOpen(src, i + 2);
      let end: number;
      if (len) {
        const close = "]" + "=".repeat(level) + "]";
        const k = src.indexOf(close, i + 2 + len);
        end = k < 0 ? n : k + close.length;
      } else {
        const k = src.indexOf("\n", i);
        end = k < 0 ? n : k;
      }
      mark(i, end, COMMENT);
      i = end;
      continue;
    }
    // long strings
    if (c === "[") {
      const [len, level] = longOpen(src, i);
      if (len) {
        const close = "]" + "=".repeat(level) + "]";
        const k = src.indexOf(close, i + len);
        const end = k < 0 ? n : k + close.length;
        const cend = k < 0 ? n : k;
        tokens.push({ type: "string", value: src.slice(i, end), start: i, end, cstart: i + len, cend });
        mark(i, end, STRING);
        i = end;
        continue;
      }
    }
    // quoted strings
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === c) break;
        if (d === "\n") break; // unterminated: stop at end of line
        j++;
      }
      const closed = j < n && src[j] === c;
      const end = closed ? j + 1 : Math.min(j, n);
      tokens.push({ type: "string", value: src.slice(i, end), start: i, end, cstart: i + 1, cend: closed ? j : end });
      mark(i, end, STRING);
      i = end;
      continue;
    }
    if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && NAME_CHAR.test(src[j]!)) j++;
      tokens.push({ type: "name", value: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(0[xX][0-9a-fA-F]*(\.[0-9a-fA-F]*)?([pP][+-]?[0-9]+)?|[0-9]*\.?[0-9]*([eE][+-]?[0-9]+)?)/.exec(src.slice(i, i + 64));
      const len = Math.max(1, m?.[0].length ?? 1);
      tokens.push({ type: "number", value: src.slice(i, i + len), start: i, end: i + len });
      i += len;
      continue;
    }
    let op = c;
    for (const o of OPS3) if (src.startsWith(o, i)) op = o;
    if (op.length === 1) for (const o of OPS2) if (src.startsWith(o, i)) op = o;
    tokens.push({ type: "op", value: op, start: i, end: i + op.length });
    i += op.length;
  }
  return { tokens, region };
}

/** Region map for XML: comments are COMMENT, attribute values STRING, the rest CODE. */
export function regionsXml(src: string): Uint8Array {
  const n = src.length;
  const region = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    if (src.startsWith("<!--", i)) {
      const k = src.indexOf("-->", i + 4);
      const end = k < 0 ? n : k + 3;
      region.fill(COMMENT, i, end);
      i = end;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const k = src.indexOf("]]>", i);
      i = k < 0 ? n : k + 3;
      continue;
    }
    if (src[i] === "<") {
      // inside a tag: mark quoted attribute values
      let j = i + 1;
      while (j < n && src[j] !== ">") {
        const q = src[j];
        if (q === '"' || q === "'") {
          const k = src.indexOf(q, j + 1);
          const end = k < 0 ? n : k + 1;
          region.fill(STRING, j, end);
          j = end;
          continue;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return region;
}

/** Region map for a TOC: "#" lines that are not "##" metadata are COMMENT. */
export function regionsToc(src: string): Uint8Array {
  const region = new Uint8Array(src.length);
  let start = 0;
  while (start < src.length) {
    let end = src.indexOf("\n", start);
    if (end < 0) end = src.length;
    const line = src.slice(start, end).trimStart();
    if (line.startsWith("#") && !line.startsWith("##")) region.fill(COMMENT, start, end);
    start = end + 1;
  }
  return region;
}

/** Offsets of line starts, for offset -> 1-based line lookups. */
export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(private readonly src: string) {
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  line(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  /** The text of the line containing offset, trimmed; long lines are windowed around the offset. */
  text(offset: number, max = 160): string {
    const ln = this.line(offset);
    const s = this.starts[ln - 1]!;
    const e = ln < this.starts.length ? this.starts[ln]! - 1 : this.src.length;
    const raw = this.src.slice(s, e).replace(/\r$/, "");
    const trimmed = raw.trim();
    if (trimmed.length <= max) return trimmed;
    const lead = raw.length - raw.trimStart().length;
    const col = Math.max(0, offset - s - lead);
    const from = Math.max(0, Math.min(col - Math.floor(max / 3), trimmed.length - max));
    return (from > 0 ? "…" : "") + trimmed.slice(from, from + max) + (from + max < trimmed.length ? "…" : "");
  }
}
