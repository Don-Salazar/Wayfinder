// Scanning engine for the identifier inventory.
//
// Flow: collect source files -> prepare (whole-tree facts: saved-variable
// names, globals the addon defines, frame names, asset names) -> per file, run
// every rule of rules.ts in table order. A rule reports a span; the first rule
// to claim a span owns it, later overlapping reports are dropped, so every
// source character belongs to at most one finding. Finally every raw
// "RXP"/"RestedXP" occurrence not inside a claimed span becomes an
// "unclassified" finding, so the counts always add up to the raw total.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "../lib/files.ts";
import { loadOrderByGameType, type GameType } from "../check-manifests/manifest.ts";
import { CODE, COMMENT, lexLua, LineIndex, regionsToc, regionsXml, STRING, type Token } from "./lex.ts";

export type Lang = "lua" | "xml" | "toc";
export type Status = "forever" | "other" | "library";

/** Top-level folders that are not addon source. */
export const SKIP_TOP = new Set(["node_modules", ".tools", "docs", "tools", "tests", ".git"]);
const EXT_LANG: Record<string, Lang> = { lua: "lua", xml: "xml", toc: "toc" };

/** The raw pattern whose every occurrence must be accounted for. */
export const RAW_RE = /restedxp|rxp/gi;

export interface SourceFile {
  path: string;
  lang: Lang;
  src: string;
  status: Status;
  loadedOn: GameType[];
  /** Guide content file (Lua under Guides/ or lang/Guides-*, or calls the global RXPGuides.RegisterGuide). */
  isGuide: boolean;
}

export interface Span {
  start: number;
  end: number;
  text: string;
}

export interface XmlAttr {
  tag: string;
  attr: string;
  value: string;
  vstart: number;
  vend: number;
}

/** Whole-tree facts gathered before classification. */
export interface TreeInfo {
  /** Saved-variable names declared in any TOC. */
  savedVars: string[];
  /** Global names the addon itself defines (non-library files), with where. */
  addonGlobals: Map<string, string>;
  /** Lower-case base names (no extension) of every tracked file, for asset-name matching. */
  assetNames: Set<string>;
  /** Names of virtual XML templates. */
  xmlTemplates: Set<string>;
  /** TOC base names (the addon folder name the client expects). */
  addonNames: string[];
  /** AceGUI widget type names the addon registers (local Type, Version = "X"). */
  widgetTypes: Set<string>;
}

export interface Hit {
  category: string;
  rule: string;
  id: string;
  file: string;
  line: number;
  start: number;
  end: number;
  detail?: string;
  text: string;
  /** Raw RXP/RestedXP occurrences inside this hit's span. */
  raw: number;
}

export interface FileResult {
  hits: Hit[];
  rawTotal: number;
}

const LUA_KEYWORDS = new Set(
  "and break do else elseif end false for function if in local nil not or repeat return then true until while goto".split(" "),
);

// ---------------------------------------------------------------- file set

/** Tracked files (git ls-files), or every file on disk if git is unavailable. */
export function trackedFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
    return out.split("\0").filter(Boolean).sort();
  } catch {
    return listFiles(root);
  }
}

export function langOf(path: string): Lang | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return EXT_LANG[ext] ?? null;
}

export function isGuidePath(path: string): boolean {
  return /^(guides|lang\/guides-[^/]+)\//i.test(path);
}

export function isLibraryPath(path: string): boolean {
  return /^libs\//i.test(path);
}

/** Load the scannable source set with load status per file. */
export function collectSources(root: string, opts: { files?: string[] } = {}): SourceFile[] {
  const all = opts.files ?? trackedFiles(root);
  const byGame = loadOrderByGameType(root);
  const loaded = new Map<string, GameType[]>();
  for (const [g, files] of byGame) for (const f of files) {
    const k = f.toLowerCase();
    const arr = loaded.get(k) ?? [];
    if (!arr.includes(g)) arr.push(g);
    loaded.set(k, arr);
  }
  // Bindings.xml is not listed in any TOC: the client loads it from the
  // addon folder whenever the addon itself loads (any game type with a TOC).
  const anyToc = [...byGame].filter(([, files]) => files.length > 0).map(([g]) => g);

  const out: SourceFile[] = [];
  for (const path of all) {
    const top = path.split("/")[0]!;
    if (SKIP_TOP.has(top) && path.includes("/")) continue;
    const lang = langOf(path);
    if (!lang) continue;
    const buf = readFileSync(join(root, path));
    if (buf.includes(0)) continue; // binary
    let src = buf.toString("utf8");
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
    const loadedOn = path.toLowerCase() === "bindings.xml" ? anyToc : (loaded.get(path.toLowerCase()) ?? []);
    const status: Status = isLibraryPath(path) ? "library" : loadedOn.includes("camelot") ? "forever" : "other";
    const isGuide = lang === "lua" && (isGuidePath(path) || /(?<![.\w])RXPGuides\s*\.\s*RegisterGuide\s*\(/.test(src));
    out.push({ path, lang, src, status, loadedOn, isGuide });
  }
  return out;
}

// ---------------------------------------------------------------- Lua structure

export interface LuaAnalysis {
  tokens: Token[];
  region: Uint8Array;
  /** Names declared local anywhere in the file (incl. params and loop vars). Scope-insensitive. */
  locals: Set<string>;
  /** Brace depth ({...}) at each token. */
  braceDepth: Int32Array;
  /** Global writes found in this file. */
  writes: GlobalWrite[];
}

export interface GlobalWrite {
  /** Global name written (for field writes: the root global). */
  name: string;
  kind: "assign" | "function" | "_G" | "field";
  /** Display id: "Name", "_G.Name", "Root.field". */
  id: string;
  start: number;
  end: number;
}

function isOp(t: Token | undefined, v: string): boolean {
  return !!t && t.type === "op" && t.value === v;
}

function strContent(src: string, t: Token): string {
  return src.slice(t.cstart ?? t.start, t.cend ?? t.end);
}

/** Index of the matching opener for a closer at i (scanning backwards), or -1. */
function matchBack(tokens: Token[], i: number, open: string, close: string): number {
  let depth = 0;
  for (let k = i; k >= 0; k--) {
    if (isOp(tokens[k], close)) depth++;
    else if (isOp(tokens[k], open) && --depth === 0) return k;
  }
  return -1;
}

interface VarRef {
  rootIdx: number;
  endIdx: number;
  /** Selector chain after the root: names or literal string keys; null entry for computed keys. */
  chain: (string | null)[];
  /** Token index of the first selector's last token (for spans like "Root.field"). */
  firstSelEnd: number;
}

/** Parse a var (Name {.Name | [exp]}) ending at token i, backwards. `colon` also accepts a:b (method declarations). */
function parseVarBack(src: string, tokens: Token[], i: number, colon = false): VarRef | null {
  const chain: (string | null)[] = [];
  const selEnds: number[] = [];
  let k = i;
  for (;;) {
    const t = tokens[k];
    if (!t) return null;
    if (isOp(t, "]")) {
      const o = matchBack(tokens, k, "[", "]");
      if (o < 0) return null;
      const inner = tokens.slice(o + 1, k);
      chain.unshift(inner.length === 1 && inner[0]!.type === "string" ? strContent(src, inner[0]!) : null);
      selEnds.unshift(k);
      k = o - 1;
      continue;
    }
    if (t.type === "name" && !LUA_KEYWORDS.has(t.value)) {
      if (isOp(tokens[k - 1], ".") || (colon && isOp(tokens[k - 1], ":"))) {
        chain.unshift(t.value);
        selEnds.unshift(k);
        k -= 2;
        continue;
      }
      return { rootIdx: k, endIdx: i, chain, firstSelEnd: selEnds[0] ?? k };
    }
    return null;
  }
}

export function analyzeLua(src: string): LuaAnalysis {
  const { tokens, region } = lexLua(src);
  const locals = new Set<string>();
  const braceDepth = new Int32Array(tokens.length);
  let depth = 0;
  tokens.forEach((t, i) => {
    if (isOp(t, "}")) depth = Math.max(0, depth - 1);
    braceDepth[i] = depth;
    if (isOp(t, "{")) depth++;
  });

  // locals, params, loop variables
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== "name") continue;
    if (t.value === "local") {
      let k = i + 1;
      if (tokens[k]?.value === "function") {
        if (tokens[k + 1]?.type === "name") locals.add(tokens[k + 1]!.value);
        continue;
      }
      while (tokens[k]?.type === "name") {
        locals.add(tokens[k]!.value);
        k++;
        if (isOp(tokens[k], "<")) k += 3; // <const>/<close>
        if (!isOp(tokens[k], ",")) break;
        k++;
      }
    } else if (t.value === "function") {
      let k = i + 1;
      while (k < tokens.length && !isOp(tokens[k], "(")) k++;
      for (k++; k < tokens.length && !isOp(tokens[k], ")"); k++) if (tokens[k]!.type === "name") locals.add(tokens[k]!.value);
    } else if (t.value === "for") {
      for (let k = i + 1; k < tokens.length; k++) {
        const u = tokens[k]!;
        if (u.type === "name" && u.value !== "in") locals.add(u.value);
        else if (!isOp(u, ",")) break;
      }
    }
  }
  locals.delete("_G");
  locals.add("self"); // implicit parameter of every method

  const writes: GlobalWrite[] = [];
  const recordVar = (v: VarRef, kind: "assign" | "function") => {
    const root = tokens[v.rootIdx]!;
    if (locals.has(root.value)) return;
    if (root.value === "_G") {
      const key = v.chain[0];
      if (v.chain.length === 0) return;
      if (v.chain.length >= 2 && key) {
        // _G.Name.field = ... is a field write on the global Name
        const selEnd = tokens[v.endIdx]!;
        const sel = tokens[v.firstSelEnd]!;
        const s0 = sel.type === "string" ? tokens[v.firstSelEnd - 1]! : sel;
        writes.push({ name: key, kind: "field", id: `${key}${src.slice(sel.end, selEnd.end).replace(/\s*([.:[\]])\s*/g, "$1")}`.slice(0, 80), start: s0.start, end: selEnd.end });
        return;
      }
      const selTok = tokens[v.firstSelEnd]!;
      if (key) {
        // span: the key itself (name token or the string's content)
        const s = selTok.type === "name" ? selTok : tokens[v.firstSelEnd - 1]!;
        const start = s.type === "string" ? (s.cstart ?? s.start) : s.start;
        const end = s.type === "string" ? (s.cend ?? s.end) : s.end;
        writes.push({ name: key, kind: "_G", id: key, start, end });
      } else {
        writes.push({ name: "", kind: "_G", id: src.slice(root.start, selTok.end), start: root.start, end: selTok.end });
      }
      return;
    }
    if (v.chain.length === 0) {
      writes.push({ name: root.value, kind, id: root.value, start: root.start, end: root.end });
    } else {
      const selEnd = tokens[v.firstSelEnd]!;
      writes.push({ name: root.value, kind: "field", id: src.slice(root.start, selEnd.end).replace(/\s*([.:[\]])\s*/g, "$1"), start: root.start, end: selEnd.end });
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isOp(t, "=") && braceDepth[i] === 0) {
      const vars: VarRef[] = [];
      let k = i - 1;
      for (;;) {
        const v = parseVarBack(src, tokens, k);
        if (!v) break;
        vars.push(v);
        k = v.rootIdx - 1;
        if (isOp(tokens[k], ",")) k--;
        else break;
      }
      if (!vars.length) continue;
      const before = tokens[k];
      if (before && before.type === "name" && (before.value === "local" || before.value === "for")) continue;
      if (before && isOp(before, ">")) continue; // local x <const> = ...
      for (const v of vars) recordVar(v, "assign");
    } else if (t.type === "name" && t.value === "function" && tokens[i - 1]?.value !== "local") {
      // function Name.a.b:c(...)
      let k = i + 1;
      if (tokens[k]?.type !== "name") continue;
      while (isOp(tokens[k + 1], ".") || isOp(tokens[k + 1], ":")) k += 2;
      const v = parseVarBack(src, tokens, k, true);
      if (v) recordVar(v, "function");
    }
  }
  return { tokens, region, locals, braceDepth, writes };
}

// ---------------------------------------------------------------- XML attributes

export function xmlAttrs(src: string, region: Uint8Array): XmlAttr[] {
  const out: XmlAttr[] = [];
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (region[m.index] !== CODE) continue;
    const lt = src.lastIndexOf("<", m.index);
    const tag = /^<\s*([\w:.-]+)/.exec(src.slice(lt, lt + 80))?.[1] ?? "";
    const value = m[3] ?? m[4] ?? "";
    const vstart = m.index + m[0].length - value.length - 1;
    out.push({ tag, attr: m[1]!, value, vstart, vend: vstart + value.length });
  }
  return out;
}

// ---------------------------------------------------------------- rule context

export interface RuleCtx {
  f: SourceFile;
  tree: TreeInfo;
  region: Uint8Array;
  lines: LineIndex;
  /** Lua analysis (Lua files only). */
  lua?: LuaAnalysis;
  /** Report a span; returns false if an earlier rule already claimed any of it. */
  emit(start: number, end: number, id: string, detail?: string): boolean;
  /** Report a finding that has no span in the file (e.g. a file name). */
  emitMeta(id: string, detail?: string): void;
  /** Argument n (0-based) of the call whose "(" is at offset paren. */
  arg(paren: number, n?: number): Span | null;
  attrs(): XmlAttr[];
  /** Move the most recent emitted finding to another category. */
  recategorize?(category: string): void;
}

export type RegionReq = "code" | "string" | "comment" | "notComment" | "any";

export interface RuleBase {
  /** Rule id, unique. */
  id: string;
  /** Category id (see CATEGORIES). */
  category: string;
  langs: Lang[];
  /** Lower-case substrings; the rule is skipped for files containing none of them. */
  hint?: string[];
  /** Only for files passing this filter. */
  files?: (f: SourceFile) => boolean;
  /** Merge this rule's findings per (file, identifier) in the outputs. */
  aggregate?: boolean;
  detail?: string;
}

export interface RegexRule extends RuleBase {
  re: RegExp;
  /** Region required at the match start (default notComment). */
  anchor?: RegionReq;
  /** Region required at the reported span start (default notComment). */
  at?: RegionReq;
  /** Custom reporting; default reports the named group "id" (or the whole match). */
  pick?: (m: RegExpExecArray, ctx: RuleCtx) => void;
  /** Normalise the reported identifier. */
  norm?: (id: string) => string;
}

export interface FnRule extends RuleBase {
  run: (ctx: RuleCtx) => void;
}

export type Rule = RegexRule | FnRule;

export function regionOk(region: Uint8Array, at: number, req: RegionReq): boolean {
  const r = region[at];
  switch (req) {
    case "code":
      return r === CODE;
    case "string":
      return r === STRING;
    case "comment":
      return r === COMMENT;
    case "notComment":
      return r !== COMMENT;
    default:
      return true;
  }
}

/** Find argument n of a call, scanning from the "(" at paren. Strings/comments are skipped via the region map. */
export function callArg(src: string, region: Uint8Array, paren: number, n = 0): Span | null {
  let depth = 0;
  let argNo = 0;
  let start = paren + 1;
  for (let i = paren + 1; i < src.length; i++) {
    if (region[i] !== CODE) continue;
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      if (depth === 0) {
        if (argNo === n) return trimSpan(src, start, i);
        return null;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      if (argNo === n) return trimSpan(src, start, i);
      argNo++;
      start = i + 1;
    }
  }
  return null;
}

function trimSpan(src: string, a: number, b: number): Span | null {
  while (a < b && /\s/.test(src[a]!)) a++;
  while (b > a && /\s/.test(src[b - 1]!)) b--;
  // strip a trailing line comment
  const text = src.slice(a, b);
  if (!text) return null;
  return { start: a, end: b, text };
}

/** Display form of an argument: a lone string literal is unquoted, anything else is whitespace-collapsed. */
export function argId(s: Span): string {
  const m = /^(["'])([^"']*)\1$/.exec(s.text);
  return m ? m[2]! : s.text.replace(/\s+/g, " ");
}

// ---------------------------------------------------------------- prepare

export function prepare(files: SourceFile[]): TreeInfo {
  const savedVars = new Set<string>();
  const addonGlobals = new Map<string, string>();
  const assetNames = new Set<string>();
  const xmlTemplates = new Set<string>();
  const addonNames = new Set<string>();
  const widgetTypes = new Set<string>();
  for (const f of files) {
    if (f.lang === "lua" && f.status !== "library")
      for (const m of f.src.matchAll(/\blocal\s+Type\s*,\s*Version\s*=\s*["']([^"']+)["']/g)) widgetTypes.add(m[1]!);
    if (f.lang === "toc") {
      if (!f.path.includes("/")) addonNames.add(f.path.replace(/(_(Mainline|Classic|Vanilla|TBC|Wrath|Cata|Mists|Standard|Forever|Camelot))?\.toc$/i, ""));
      for (const m of f.src.matchAll(/^##\s*SavedVariables(?:PerCharacter)?\s*:\s*(.*)$/gim))
        for (const n of m[1]!.split(",")) if (n.trim()) savedVars.add(n.trim());
    }
  }
  const sv = savedVars;
  for (const f of files) {
    if (f.status === "library") continue;
    if (f.lang === "lua") {
      if (!/=|function/.test(f.src)) continue;
      const a = analyzeLua(f.src);
      for (const w of a.writes) {
        if ((w.kind === "assign" || w.kind === "function" || w.kind === "_G") && w.name && !sv.has(w.name) && !addonGlobals.has(w.name))
          addonGlobals.set(w.name, `${f.path} (${w.kind})`);
      }
      // CreateFrame("T", "LiteralName")
      for (const m of f.src.matchAll(/\bCreateFrame\s*\(/g)) {
        if (a.region[m.index] !== CODE) continue;
        const s = callArg(f.src, a.region, m.index + m[0].length - 1, 1);
        const lit = s && /^(["'])([A-Za-z_]\w*)\1$/.exec(s.text);
        if (lit && !addonGlobals.has(lit[2]!)) addonGlobals.set(lit[2]!, `${f.path} (CreateFrame)`);
      }
    } else if (f.lang === "xml") {
      const region = regionsXml(f.src);
      const attrs = xmlAttrs(f.src, region);
      const virtualTags = new Set<number>();
      for (const at of attrs) if (at.attr === "virtual" && at.value === "true") virtualTags.add(f.src.lastIndexOf("<", at.vstart));
      for (const at of attrs) {
        if (at.attr !== "name" || /^(Binding|Script|Include)$/.test(at.tag) || at.value.includes("$")) continue;
        if (virtualTags.has(f.src.lastIndexOf("<", at.vstart))) xmlTemplates.add(at.value);
        if (!addonGlobals.has(at.value)) addonGlobals.set(at.value, `${f.path} (XML name)`);
      }
    }
  }
  return { savedVars: [...savedVars].sort(), addonGlobals, assetNames, xmlTemplates, addonNames: [...addonNames].sort(), widgetTypes };
}

/** Asset base names from the full tracked list (not only scanned files). */
export function addAssetNames(tree: TreeInfo, allPaths: string[]): void {
  for (const p of allPaths) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    tree.assetNames.add((dot > 0 ? base.slice(0, dot) : base).toLowerCase());
  }
}

// ---------------------------------------------------------------- scan one file

export function scanFile(f: SourceFile, tree: TreeInfo, rules: readonly Rule[]): FileResult {
  const lua = f.lang === "lua" ? analyzeLua(f.src) : undefined;
  const region = lua ? lua.region : f.lang === "xml" ? regionsXml(f.src) : regionsToc(f.src);
  const lines = new LineIndex(f.src);
  const owner = new Int32Array(f.src.length); // hit index + 1
  const hits: Hit[] = [];
  const lower = f.src.toLowerCase();
  let attrsCache: XmlAttr[] | undefined;
  let current: Rule = rules[0]!;

  const ctx: RuleCtx = {
    f,
    tree,
    region,
    lines,
    ...(lua ? { lua } : {}),
    emit(start, end, id, detail) {
      if (end <= start) return false;
      for (let i = start; i < end; i++) if (owner[i]) return false;
      hits.push({
        category: current.category,
        rule: current.id,
        id,
        file: f.path,
        line: lines.line(start),
        start,
        end,
        ...(detail ?? current.detail ? { detail: detail ?? current.detail } : {}),
        text: lines.text(start),
        raw: 0,
      });
      owner.fill(hits.length, start, end);
      return true;
    },
    emitMeta(id, detail) {
      hits.push({ category: current.category, rule: current.id, id, file: f.path, line: 0, start: -1, end: -1, ...(detail ? { detail } : {}), text: "", raw: 0 });
    },
    arg(paren, n = 0) {
      return callArg(f.src, region, paren, n);
    },
    recategorize(category) {
      const h = hits[hits.length - 1];
      if (h) h.category = category;
    },
    attrs() {
      return (attrsCache ??= f.lang === "xml" ? xmlAttrs(f.src, region) : []);
    },
  };

  for (const rule of rules) {
    if (!rule.langs.includes(f.lang)) continue;
    if (rule.files && !rule.files(f)) continue;
    if (rule.hint && !rule.hint.some((h) => lower.includes(h))) continue;
    current = rule;
    if ("run" in rule) {
      rule.run(ctx);
      continue;
    }
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(f.src))) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      if (!regionOk(region, m.index, rule.anchor ?? "notComment")) continue;
      if (rule.pick) {
        rule.pick(m, ctx);
        continue;
      }
      const span = m.indices?.groups?.id ?? m.indices?.[0];
      if (!span) continue;
      if (!regionOk(region, span[0], rule.at ?? "notComment")) continue;
      const raw = f.src.slice(span[0], span[1]);
      ctx.emit(span[0], span[1], rule.norm ? rule.norm(raw) : raw);
    }
  }

  // raw coverage
  let rawTotal = 0;
  const uncovered: { start: number; end: number }[] = [];
  RAW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RAW_RE.exec(f.src))) {
    rawTotal++;
    const o = owner[m.index];
    if (o) hits[o - 1]!.raw++;
    else uncovered.push({ start: m.index, end: m.index + m[0].length });
  }
  for (const u of uncovered) {
    let a = u.start;
    let b = u.end;
    while (a > 0 && /[\w-]/.test(f.src[a - 1]!)) a--;
    while (b < f.src.length && /[\w-]/.test(f.src[b]!)) b++;
    const where = region[u.start] === STRING ? "string" : region[u.start] === COMMENT ? "comment" : "code";
    hits.push({
      category: "unclassified",
      rule: "unclassified",
      id: f.src.slice(a, b),
      file: f.path,
      line: lines.line(u.start),
      start: u.start,
      end: u.end,
      detail: `in ${where}`,
      text: lines.text(u.start),
      raw: 1,
    });
  }
  hits.sort((x, y) => x.start - y.start || x.end - y.end);
  return { hits, rawTotal };
}
