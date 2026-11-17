// Parser for WoW SavedVariables files: a sequence of `Name = <value>`
// assignments whose values are Lua literals and table constructors. A small
// recursive-descent parser over the text; nothing is evaluated.
//
// Value mapping to JSON:
//   strings, numbers, booleans  -> as is (hex and exponents are decoded)
//   nil                         -> null at top level; omitted inside tables
//   table with only keys 1..n   -> array (n >= 1)
//   any other table             -> object; numeric and boolean keys become
//                                  their decimal / "true" / "false" strings.
//                                  An empty table {} becomes {}.
// Lua's `-- [n]` index comments, other line comments and --[[ ]] block
// comments are skipped. CRLF and a UTF-8 BOM are accepted.

export type LuaValue = string | number | boolean | null | LuaValue[] | { [key: string]: LuaValue };

export class ParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${line}:${column}: ${message}`);
  }
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", "\\": "\\", '"': '"', "'": "'", "\n": "\n" };

type Key = string | number | boolean;

class Parser {
  private pos = 0;

  constructor(private readonly src: string) {}

  private fail(message: string, at = this.pos): never {
    let line = 1;
    let col = 1;
    for (let i = 0; i < at && i < this.src.length; i++) {
      if (this.src[i] === "\n") {
        line++;
        col = 1;
      } else col++;
    }
    throw new ParseError(message, line, col);
  }

  peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  /** Length of the "[==[" opener at pos (returns level), or -1. */
  private longBracketLevel(at: number): number {
    if (this.src[at] !== "[") return -1;
    let i = at + 1;
    while (this.src[i] === "=") i++;
    return this.src[i] === "[" ? i - at - 1 : -1;
  }

  private readLongBracket(): string {
    const level = this.longBracketLevel(this.pos);
    const start = this.pos;
    this.pos += level + 2;
    const close = `]${"=".repeat(level)}]`;
    const end = this.src.indexOf(close, this.pos);
    if (end < 0) this.fail("unfinished long bracket", start);
    let text = this.src.slice(this.pos, end);
    this.pos = end + close.length;
    if (text.startsWith("\r\n")) text = text.slice(2);
    else if (text.startsWith("\n")) text = text.slice(1);
    return text;
  }

  skipSpace(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v") {
        this.pos++;
      } else if (c === "-" && this.peek(1) === "-") {
        this.pos += 2;
        if (this.longBracketLevel(this.pos) >= 0) {
          this.readLongBracket();
        } else {
          while (!this.atEnd() && this.peek() !== "\n") this.pos++;
        }
      } else return;
    }
  }

  expect(ch: string): void {
    this.skipSpace();
    if (this.peek() !== ch) this.fail(`expected "${ch}" but found ${this.describe()}`);
    this.pos++;
  }

  private describe(): string {
    return this.atEnd() ? "end of file" : JSON.stringify(this.src.slice(this.pos, this.pos + 12));
  }

  name(): string {
    this.skipSpace();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos, this.pos + 256));
    if (!m) this.fail(`expected a name but found ${this.describe()}`);
    this.pos += m[0].length;
    return m[0];
  }

  private string(): string {
    const quote = this.peek();
    const start = this.pos;
    this.pos++;
    let out = "";
    for (;;) {
      if (this.atEnd()) this.fail("unfinished string", start);
      const c = this.src[this.pos]!;
      if (c === quote) {
        this.pos++;
        return out;
      }
      if (c === "\n") this.fail("newline in string", start);
      if (c !== "\\") {
        out += c;
        this.pos++;
        continue;
      }
      let e = this.src[this.pos + 1] ?? "";
      if (e === "\r") {
        // "\" + CRLF: one escaped newline
        this.pos += this.src[this.pos + 2] === "\n" ? 3 : 2;
        out += "\n";
        continue;
      }
      if (/[0-9]/.test(e)) {
        const m = /^[0-9]{1,3}/.exec(this.src.slice(this.pos + 1, this.pos + 4))!;
        const code = Number(m[0]);
        if (code > 255) this.fail(`escape \\${m[0]} is too large`);
        out += String.fromCharCode(code);
        this.pos += 1 + m[0].length;
        continue;
      }
      const mapped = ESCAPES[e];
      if (mapped === undefined) {
        e = e || "end of file";
        this.fail(`invalid escape \\${e}`);
      }
      out += mapped;
      this.pos += 2;
    }
  }

  private number(): number {
    const rest = this.src.slice(this.pos, this.pos + 64);
    const hex = /^0[xX][0-9A-Fa-f]+/.exec(rest);
    if (hex) {
      this.pos += hex[0].length;
      return parseInt(hex[0].slice(2), 16);
    }
    const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (!m) this.fail(`expected a number but found ${this.describe()}`);
    this.pos += m[0].length;
    return Number(m[0]);
  }

  value(): LuaValue {
    this.skipSpace();
    const c = this.peek();
    if (c === "{") return this.table();
    if (c === '"' || c === "'") return this.string();
    if (c === "[" && this.longBracketLevel(this.pos) >= 0) return this.readLongBracket();
    if (c === "-") {
      this.pos++;
      this.skipSpace();
      const v = this.value();
      if (typeof v !== "number") this.fail("unary minus needs a number");
      return -v;
    }
    if (/[0-9.]/.test(c)) return this.number();
    if (/[A-Za-z_]/.test(c)) {
      const start = this.pos;
      const word = this.name();
      if (word === "true") return true;
      if (word === "false") return false;
      if (word === "nil") return null;
      // Some writers emit inf / nan for math.huge and 0/0.
      if (word === "inf") return Infinity;
      if (word === "nan") return NaN;
      this.fail(`unexpected name "${word}" in a value`, start);
    }
    this.fail(`expected a value but found ${this.describe()}`);
  }

  private table(): LuaValue {
    const open = this.pos;
    this.expect("{");
    const entries = new Map<Key, LuaValue>();
    let index = 1;
    for (;;) {
      this.skipSpace();
      if (this.peek() === "}") {
        this.pos++;
        break;
      }
      if (this.atEnd()) this.fail("unfinished table", open);
      let key: Key | undefined;
      if (this.peek() === "[" && this.longBracketLevel(this.pos) < 0) {
        this.pos++;
        const k = this.value();
        if (k === null || (typeof k === "number" && Number.isNaN(k))) this.fail("table key is nil or NaN");
        if (typeof k === "object") this.fail("table key is a table");
        key = k;
        this.expect("]");
        this.expect("=");
      } else if (/[A-Za-z_]/.test(this.peek())) {
        // name = value, unless the name is a value keyword (true/false/nil) used positionally
        const save = this.pos;
        const word = this.name();
        this.skipSpace();
        if (this.peek() === "=" && this.peek(1) !== "=") {
          this.pos++;
          key = word;
        } else this.pos = save;
      }
      const v = this.value();
      if (key === undefined) {
        key = index;
        index++;
      }
      if (v === null) entries.delete(key);
      else entries.set(key, v);
      this.skipSpace();
      const sep = this.peek();
      if (sep === "," || sep === ";") this.pos++;
      else if (sep !== "}") this.fail(`expected "," or "}" but found ${this.describe()}`);
    }
    return toJson(entries);
  }
}

function toJson(entries: Map<Key, LuaValue>): LuaValue {
  const n = entries.size;
  let isArray = n > 0;
  if (isArray) {
    for (let i = 1; i <= n; i++) {
      if (!entries.has(i)) {
        isArray = false;
        break;
      }
    }
  }
  if (isArray) {
    const arr: LuaValue[] = [];
    for (let i = 1; i <= n; i++) arr.push(entries.get(i)!);
    return arr;
  }
  const obj: { [key: string]: LuaValue } = {};
  for (const [k, v] of entries) obj[String(k)] = v;
  return obj;
}

/** Parse a SavedVariables file into { VariableName: value }. Later assignments win. */
export function parseSavedVariables(text: string): Record<string, LuaValue> {
  const p = new Parser(text.replace(/^﻿/, ""));
  const out: Record<string, LuaValue> = {};
  for (;;) {
    p.skipSpace();
    if (p.atEnd()) break;
    const name = p.name();
    p.expect("=");
    out[name] = p.value();
    p.skipSpace();
    if (p.peek() === ";") p.expect(";");
  }
  return out;
}

/** JSON text with non-finite numbers as strings (JSON has no Infinity/NaN). */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v), 2);
}
