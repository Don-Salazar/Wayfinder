// Rename engine for tools/build-addon: applies rebrand.json to Lua, XML and
// TOC text. Pure functions (no file I/O) so they can be unit-tested.
//
// Lua is tokenized with tools/inventory-ids/lex.ts, so code names, string
// literals and comments are told apart; comments are never touched. Every
// replacement is made inside one token or attribute value, and no rule may
// produce a newline, so the line count of every file is unchanged.

import { globToRegExp } from "../lib/files.ts";
import { lexLua, regionsXml, STRING, type Token } from "../inventory-ids/lex.ts";

export interface ExactRule { id: string; from: string; to: string; reason: string }
export interface PatternRule { id: string; pattern: string; flags?: string; to: string; reason: string }
export interface KeepRule { pattern: string; reason: string }
export interface CallRule { id: string; call: string; arg: number; from: string; to: string; reason: string }

export interface RebrandConfig {
  description?: string;
  guideFiles: { globs: string[]; reason: string; renameGlobals: string[] };
  verbatim: { glob: string; reason: string }[];
  /** File references: only the listed "strings" rules may change them. */
  fileReferences: { xmlAttributes: string[]; rules: string[]; reason: string };
  identifiers: { exact: ExactRule[]; prefix: PatternRule[]; infix: PatternRule[] };
  keepLiterals: KeepRule[];
  calls: CallRule[];
  strings: PatternRule[];
  branding: { keep: KeepRule[]; rules: PatternRule[] };
}

/** Replacement counts per rule id. */
export type Counts = Map<string, number>;

const bump = (c: Counts, id: string, n = 1) => c.set(id, (c.get(id) ?? 0) + n);

const HIT = /rxp|restedxp|rested xp/i;
const IDENT = /^\$?[A-Za-z_][A-Za-z0-9_]*$/;
/** An addon-defined name embedded in a longer string ("CLICK RXPItemFrameButton1:LeftButton", "RXPV2ScrollFrame%dScrollBar"). */
const RUN = /(?<![A-Za-z0-9_$])(?:RXP(?=[A-Z0-9_])|RESTEDXP_)[A-Za-z0-9_]*/g;

export function validateRebrand(c: RebrandConfig): void {
  const err = (m: string) => {
    throw new Error(`rebrand.json: ${m}`);
  };
  const ids = new Set<string>();
  const checkId = (id: string, reason: string) => {
    if (!id || ids.has(id)) err(`rule id "${id}" is missing or duplicated`);
    if (!reason || !reason.trim()) err(`rule "${id}" needs a reason`);
    ids.add(id);
  };
  const noNewline = (id: string, s: string) => {
    if (/[\r\n]/.test(s)) err(`rule "${id}" would add a line break`);
  };
  for (const r of c.identifiers.exact) {
    checkId(r.id, r.reason);
    noNewline(r.id, r.to);
    if (!IDENT.test(r.from) || !IDENT.test(r.to)) err(`exact rule "${r.id}" must map a name to a name`);
  }
  for (const r of [...c.identifiers.prefix, ...c.identifiers.infix, ...c.strings, ...c.branding.rules]) {
    checkId(r.id, r.reason);
    noNewline(r.id, r.to);
    new RegExp(r.pattern, r.flags ?? "");
  }
  for (const r of c.calls) {
    checkId(r.id, r.reason);
    noNewline(r.id, r.to);
  }
  for (const k of [...c.keepLiterals, ...c.branding.keep, ...c.verbatim.map((v) => ({ pattern: v.glob, reason: v.reason }))]) {
    if (!k.reason || !k.reason.trim()) err(`keep entry "${k.pattern}" needs a reason`);
  }
  if (!c.guideFiles.reason?.trim()) err(`guideFiles needs a reason`);
  if (!c.fileReferences?.reason?.trim()) err(`fileReferences needs a reason`);
  for (const id of c.fileReferences.rules) if (!c.strings.some((r) => r.id === id)) err(`fileReferences.rules "${id}" is not a "strings" rule id`);
  for (const g of c.guideFiles.renameGlobals) if (!c.identifiers.exact.some((r) => r.from === g)) err(`guideFiles.renameGlobals "${g}" has no exact identifier rule`);
}

interface Compiled {
  exact: Map<string, ExactRule>;
  prefix: { rule: PatternRule; re: RegExp }[];
  infix: { rule: PatternRule; re: RegExp }[];
  keep: RegExp[];
  calls: CallRule[];
  strings: { rule: PatternRule; re: RegExp }[];
  brandKeep: RegExp[];
  brand: { rule: PatternRule; re: RegExp }[];
  guideGlobs: RegExp[];
  guideGlobals: Set<string>;
  verbatim: RegExp[];
  fileAttrs: Set<string>;
  fileRules: { rule: PatternRule; re: RegExp }[];
}

export class Rebrander {
  readonly counts: Counts = new Map();
  /** Every changed string literal (original content -> new content), for the collision check. */
  readonly changedLiterals = new Map<string, Set<string>>();
  /** Every string literal (engine Lua and XML values) that the build leaves unchanged. */
  readonly unchangedLiterals = new Set<string>();
  private readonly c: Compiled;

  constructor(readonly config: RebrandConfig) {
    validateRebrand(config);
    const cr = (r: PatternRule) => ({ rule: r, re: new RegExp(r.pattern, r.flags ?? "") });
    this.c = {
      exact: new Map(config.identifiers.exact.map((r) => [r.from, r])),
      prefix: config.identifiers.prefix.map(cr),
      infix: config.identifiers.infix.map((r) => ({ rule: r, re: new RegExp(r.pattern, "g") })),
      keep: config.keepLiterals.map((k) => new RegExp(k.pattern)),
      calls: config.calls,
      strings: config.strings.map(cr),
      brandKeep: config.branding.keep.map((k) => new RegExp(k.pattern)),
      brand: config.branding.rules.map(cr),
      guideGlobs: config.guideFiles.globs.map(globToRegExp),
      guideGlobals: new Set(config.guideFiles.renameGlobals),
      verbatim: config.verbatim.map((v) => globToRegExp(v.glob)),
      fileAttrs: new Set(config.fileReferences.xmlAttributes.map((a) => a.toLowerCase())),
      fileRules: config.strings.filter((r) => config.fileReferences.rules.includes(r.id)).map(cr),
    };
  }

  isGuideFile(path: string): boolean {
    return this.c.guideGlobs.some((re) => re.test(path));
  }
  isVerbatim(path: string): boolean {
    return this.c.verbatim.some((re) => re.test(path));
  }

  /** Layer 1 on one name: exact, else first matching prefix rule, then infix rules on what is left. */
  renameIdent(name: string): string {
    if (!HIT.test(name)) return name;
    const ex = this.c.exact.get(name);
    if (ex) {
      bump(this.counts, ex.id);
      return ex.to;
    }
    let out = name;
    for (const { rule, re } of this.c.prefix) {
      if (re.test(out)) {
        out = out.replace(re, rule.to);
        bump(this.counts, rule.id);
        break;
      }
    }
    for (const { rule, re } of this.c.infix) {
      re.lastIndex = 0;
      out = out.replace(re, () => {
        bump(this.counts, rule.id);
        return rule.to;
      });
    }
    return out;
  }

  private applyAll(s: string, rules: { rule: PatternRule; re: RegExp }[]): string {
    let out = s;
    for (const { rule, re } of rules) {
      let n = 0;
      out = out.replace(re, (...m) => {
        n++;
        // expand $1.. by hand so the count is exact
        return rule.to.replace(/\$(\d)/g, (_, d: string) => String(m[Number(d)] ?? ""));
      });
      if (n) bump(this.counts, rule.id, n);
    }
    return out;
  }

  /** Layers 1-3 on the content of one engine string literal or XML attribute value. */
  renameLiteral(content: string, call?: { name: string; arg: number }): string {
    if (call) {
      for (const r of this.c.calls) {
        if (r.call === call.name && r.arg === call.arg && r.from === content) {
          bump(this.counts, r.id);
          return r.to; // contextual: not a lookup key, so not part of the collision check
        }
      }
    }
    if (!HIT.test(content)) return this.record(content, content);
    if (this.c.keep.some((re) => re.test(content))) return this.record(content, content);
    if (IDENT.test(content)) return this.record(content, this.renameIdent(content));
    let out = this.applyAll(content, this.c.strings);
    // Branding keep-list (guide group names, credits): only the path / slash-help rules apply.
    if (this.c.brandKeep.some((re) => re.test(content))) return this.record(content, out);
    out = this.applyAll(out, this.c.brand);
    out = out.replace(RUN, (run) => this.renameIdent(run));
    return this.record(content, out);
  }

  private record(from: string, to: string): string {
    if (from === to) this.unchangedLiterals.add(from);
    else {
      const set = this.changedLiterals.get(from) ?? new Set<string>();
      set.add(to);
      this.changedLiterals.set(from, set);
    }
    return to;
  }

  /**
   * Lookup-safety check: a literal rename must be a function (same input, same
   * output everywhere) and injective, and its result must not equal a literal
   * that stays unchanged. Then two literals compare equal after the build
   * exactly when they did before, so every locale key / L("...") pair,
   * AceEvent message, popup key and frame name still matches.
   */
  collisions(): string[] {
    const out: string[] = [];
    const byResult = new Map<string, string>();
    for (const [from, tos] of this.changedLiterals) {
      if (tos.size > 1) out.push(`"${from}" is renamed differently in different places: ${[...tos].map((t) => `"${t}"`).join(", ")}`);
      for (const to of tos) {
        const prev = byResult.get(to);
        if (prev !== undefined && prev !== from) out.push(`"${prev}" and "${from}" both become "${to}"`);
        byResult.set(to, from);
        if (this.unchangedLiterals.has(to)) out.push(`"${from}" becomes "${to}", which is also an unchanged literal`);
      }
      if (this.unchangedLiterals.has(from)) out.push(`"${from}" is renamed in some places and kept in others`);
    }
    return out;
  }

  /** A file reference: only the fileReferences rules (addon-folder prefix) apply. */
  renameFileRef(content: string): string {
    return this.applyAll(content, this.c.fileRules);
  }

  /** Rename a Lua file. Guide files get only the global-name rule on code names. */
  lua(src: string, path: string): string {
    const guide = this.isGuideFile(path);
    const { tokens } = lexLua(src);
    const edits: { start: number; end: number; text: string }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.type === "name") {
        if (!HIT.test(t.value)) continue;
        if (guide) {
          const prev = tokens[i - 1];
          const isField = prev && prev.type === "op" && (prev.value === "." || prev.value === ":");
          if (isField || !this.c.guideGlobals.has(t.value)) continue;
        }
        const nv = this.renameIdent(t.value);
        if (nv !== t.value) edits.push({ start: t.start, end: t.end, text: nv });
      } else if (t.type === "string" && !guide) {
        const content = src.slice(t.cstart!, t.cend!);
        const nv = this.renameLiteral(content, HIT.test(content) ? callContext(tokens, i) : undefined);
        if (nv !== content) edits.push({ start: t.cstart!, end: t.cend!, text: nv });
      }
    }
    return applyEdits(src, edits);
  }

  /** Rename XML attribute values (names, inherits, parentKey, file paths, binding names). */
  xml(src: string): string {
    const region = regionsXml(src);
    const edits: { start: number; end: number; text: string }[] = [];
    let i = 0;
    while (i < src.length) {
      if (region[i] === STRING) {
        let j = i;
        while (j < src.length && region[j] === STRING) j++;
        // [i, j) is a quoted value including its quotes
        const content = src.slice(i + 1, j - 1);
        const attr = /([A-Za-z_:][\w:.-]*)\s*=\s*$/.exec(src.slice(Math.max(0, i - 64), i))?.[1]?.toLowerCase();
        const nv = attr && this.c.fileAttrs.has(attr) ? this.renameFileRef(content) : this.renameLiteral(content);
        if (nv !== content) edits.push({ start: i + 1, end: j - 1, text: nv });
        i = j;
      } else i++;
    }
    return applyEdits(src, edits);
  }

  /** Rename names on the TOC's SavedVariables lines; everything else in the TOC is metadata or file paths. */
  toc(src: string): string {
    return src.replace(/^(## SavedVariables(?:PerCharacter)?:)([^\r\n]*)/gm, (_, key: string, list: string) =>
      key + list.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (n) => this.renameIdent(n)),
    );
  }
}

/**
 * If tokens[i] is an argument of a call `name(...)` or `obj:name(...)`, return
 * the callee name and the 1-based argument position.
 */
export function callContext(tokens: Token[], i: number): { name: string; arg: number } | undefined {
  let depth = 0;
  let arg = 1;
  for (let k = i - 1; k >= 0; k--) {
    const t = tokens[k]!;
    if (t.type !== "op") continue;
    if (t.value === ")" || t.value === "]" || t.value === "}") depth++;
    else if (t.value === "(" || t.value === "[" || t.value === "{") {
      if (depth === 0) {
        const callee = tokens[k - 1];
        if (t.value === "(" && callee && callee.type === "name") return { name: callee.value, arg };
        return undefined;
      }
      depth--;
    } else if (t.value === "," && depth === 0) arg++;
    else if (depth === 0 && (t.value === ";" || t.value === "=")) return undefined;
  }
  return undefined;
}

export function applyEdits(src: string, edits: { start: number; end: number; text: string }[]): string {
  if (!edits.length) return src;
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const e of edits) {
    out += src.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + src.slice(pos);
}

export function lineCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
