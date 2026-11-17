// Lint rules for guide text. Engine references are to this checkout.

import { checkCondition, conditionFactions, nearest } from "./conditions.ts";
import { guideLabel, luaToNumber, padName, splitArgs, type Guide, type GuideLine } from "./parse.ts";
import type { ConditionVocab } from "./vocab.ts";

export const KINDS = {
  "unknown-header-tag": 1,
  "unknown-step-tag": 1,
  "unknown-command": 2,
  "no-name": 3,
  "no-group": 3,
  "no-steps": 3,
  "not-on-forever": 3,
  "duplicate-name": 3,
  "dead-next": 4,
  condition: 5,
  "goto-syntax": 6,
  "reserved-sequence": 7,
  "wf-header": 8,
} as const;
export type Kind = keyof typeof KINDS;

export interface Finding {
  file: string;
  line: number;
  kind: Kind;
  /** Guide label (first #name), "" for file-level findings. */
  guide: string;
  /** What is wrong, stable across line shifts (used in the baseline key). */
  token: string;
  message: string;
  suggestion?: string;
}

export interface Vocab {
  headerTags: Set<string>;
  stepTags: Set<string>;
  commands: Set<string>;
  cond: ConditionVocab;
}

type Faction = "A" | "H";
export interface Scope {
  factions: Set<Faction>;
  /** "all", "default" (enUS and other non-translated locales) or a locale code. */
  locale: string;
}

/**
 * File-level guards before the RegisterGuide call (upstream pattern, e.g.
 * Guides/forever/Horde-01-12_Durotar.lua:1-4, lang/Guides-deDE/...:1-3).
 */
export function fileScope(prelude: string): Scope {
  const factions = new Set<Faction>(["A", "H"]);
  if (/==\s*"Alliance"\s*then\s+return/.test(prelude) || /~=\s*"Horde"\s*then\s+return/.test(prelude)) factions.delete("A");
  if (/==\s*"Horde"\s*then\s+return/.test(prelude) || /~=\s*"Alliance"\s*then\s+return/.test(prelude)) factions.delete("H");
  let locale = "all";
  const m = /GetLocale\(\)\s*~=\s*"(\w+)"\s*then\s+return/.exec(prelude);
  if (m) locale = m[1]!;
  else if (/enabledLocale\[\w+\]\s*then\s+return/.test(prelude)) locale = "default";
  return { factions, locale };
}

function intersect(a: Set<Faction>, b: Set<Faction>): Set<Faction> {
  return new Set([...a].filter((x) => b.has(x)));
}

export function scopesOverlap(a: Scope, b: Scope): boolean {
  if (!(a.locale === "all" || b.locale === "all" || a.locale === b.locale)) return false;
  return intersect(a.factions, b.factions).size > 0;
}

/** Scope of a guide: its file guards and its first bare `<<` line (the pre-scan uses the first, GuideLoader.lua:466). */
export function guideScope(g: Guide): Scope {
  const s = fileScope(g.prelude);
  const first = g.bareConds[0];
  return { locale: s.locale, factions: first ? intersect(s.factions, conditionFactions(first.cond)) : s.factions };
}

const GAME_TAGS = ["classic", "tbc", "wotlk", "df", "retail", "cata", "forever"];

/** Value of the first header tag line (conditions assumed to pass). */
function firstTag(g: Guide, tag: string) {
  return g.headerTags.find((t) => t.tag === tag);
}

/**
 * Would this guide load on Forever? Mirrors:
 * - ParseGuide group lookup (GuideLoader.lua:748-777): no group -> dropped.
 * - Pre-scan (LoadGuide :440-479, one-argument form only): some header line
 *   before the first step, uppercased, must contain "#FOREVER" (`"#"..addon.game`,
 *   :460-462; the "#classic" alternative there applies only on CLASSIC, and
 *   "#DF" only on RETAIL). A guide with no step line skips the pre-scan.
 * - Parse-time game check (:815-822): if any of classic/tbc/wotlk/df/retail/
 *   cata/forever is set, forever or classic must be.
 * Conditions on header lines are assumed to pass (they are per character).
 */
export function foreverAcceptance(g: Guide): { loads: boolean; reason?: string } {
  const hasGroup = g.twoArg ? !!g.groupArg : g.headerTags.some((t) => t.tag === "group") || g.lines.some((l) => /^#group\s/.test(l.text));
  if (!hasGroup) return { loads: false, reason: "no #group: ParseGuide returns nil (GuideLoader.lua:772-775)" };
  if (!g.twoArg && g.prescanHeader) {
    const ok = g.prescanHeader.some((l) => {
      const line = l.text.replace(/^(\s*#.+?)\s*<<\s*(.+)/, "$1");
      return line.toUpperCase().includes("#FOREVER");
    });
    if (!ok) {
      const tags = GAME_TAGS.filter((t) => firstTag(g, t)).map((t) => "#" + t);
      return { loads: false, reason: `no "#forever" header line: the Forever pre-scan rejects it (GuideLoader.lua:460-463)${tags.length ? `; game tags: ${tags.join(" ")}` : ""}` };
    }
  }
  const tags = new Set(GAME_TAGS.filter((t) => firstTag(g, t)));
  if (tags.size && !(tags.has("forever") || tags.has("classic"))) return { loads: false, reason: `game tags ${[...tags].map((t) => "#" + t).join(" ")} exclude Forever (GuideLoader.lua:815-822)` };
  return { loads: true };
}

export interface Variant {
  value: string;
  factions: Set<Faction>;
}

/** Group(s) the guide can end up in: `#group X << cond` alternatives (GuideLoader.lua:756-765), else the first #group. */
export function groupVariants(g: Guide): Variant[] {
  const scope = guideScope(g);
  if (g.twoArg) return g.groupArg ? [{ value: g.groupArg, factions: scope.factions }] : [];
  const cond = g.headerTags.filter((t) => t.tag === "group" && t.cond !== undefined);
  const out: Variant[] = cond.map((t) => ({ value: t.value.trim(), factions: intersect(scope.factions, conditionFactions(t.cond)) }));
  const covered = new Set(out.flatMap((v) => [...v.factions]));
  const plain = g.headerTags.find((t) => t.tag === "group" && t.cond === undefined);
  if (plain && (!out.length || [...scope.factions].some((f) => !covered.has(f)))) out.push({ value: plain.value.trim(), factions: scope.factions });
  return out.filter((v) => v.factions.size > 0);
}

/** Zero-padded #name values (the first applicable one is kept, :879). */
export function nameVariants(g: Guide): Variant[] {
  const scope = guideScope(g);
  return g.headerTags
    .filter((t) => t.tag === "name")
    .map((t) => ({ value: padName(t.value.trim()), factions: intersect(scope.factions, conditionFactions(t.cond)) }))
    .filter((v) => v.factions.size > 0);
}

function f(g: Guide, line: GuideLine | number, kind: Kind, token: string, message: string, suggestion?: string): Finding {
  return { file: g.file, line: typeof line === "number" ? line : line.line, kind, guide: guideLabel(g), token, message, ...(suggestion ? { suggestion } : {}) };
}

/** Kinds 5 and 7 for one `<<` condition: ">>" swallowed into the condition, then the keyword check. */
function condFindings(g: Guide, line: GuideLine, cond: string, v: Vocab, out: Finding[]): void {
  let c = cond;
  const dd = c.indexOf(">>");
  if (dd >= 0) {
    out.push(f(g, line, "reserved-sequence", `<< … >>${c.slice(dd + 2).trim()}`, "display text after \"<<\" is read as part of the condition, so it is not shown (GuideLoader.lua:636 strips \"<<\" before \">>\")"));
    c = c.slice(0, dd);
  }
  for (const p of checkCondition(c, v.cond)) out.push(f(g, line, "condition", p.token, p.message, p.suggestion));
}

const GOTO_COMMANDS = new Set(["goto", "groundgoto", "flygoto"]);

/**
 * `.goto` syntax (functions.lua:1880-1979, map.lua GetMapInfo):
 *   zone,x,y[,radius[,optional]] where zone is a zone name or UiMapID and x,y
 *   are map percentages; or `UiMapID/instance,wx,wy[,…]` (zone matching
 *   `(.-)/(%d+)`) with world coordinates. x and y go through tonumber; radius
 *   through tonumber (non-numeric radius is silently ignored). Arguments
 *   after the fifth are ignored. No ID or coordinate is checked against data.
 */
export function gotoProblems(args: string): string[] {
  const a = splitArgs(args);
  const out: string[] = [];
  if (a.length === 0) return ["no arguments: the zone and coordinates are missing"];
  const zone = a[0]!;
  const fixed = /^(.*?)\/(\d+)/.exec(zone);
  if (a.length < 3) out.push(`needs zone,x,y; got ${a.length} argument${a.length === 1 ? "" : "s"}`);
  const x = a[1] !== undefined ? luaToNumber(a[1]) : undefined;
  const y = a[2] !== undefined ? luaToNumber(a[2]) : undefined;
  if (a[1] !== undefined && x === undefined) out.push(`x "${a[1]}" is not a number`);
  if (a[2] !== undefined && y === undefined) out.push(`y "${a[2]}" is not a number`);
  if (fixed) {
    if (!/^[^/]+\/\d+$/.test(zone)) out.push(`map "${zone}" does not fit UiMapID/instance`);
    else if (luaToNumber(fixed[1]!) === undefined && /^\s*$/.test(fixed[1]!)) out.push(`map "${zone}" has no map before "/"`);
  } else {
    if (luaToNumber(zone) === undefined && !/[A-Za-z]/.test(zone)) out.push(`zone "${zone}" is neither a zone name nor a number`);
    for (const [n, val] of [["x", x], ["y", y]] as const) if (val !== undefined && (val < 0 || val > 100)) out.push(`${n} ${val} is outside 0-100 (zone-percent form; world coordinates need "UiMapID/instance")`);
  }
  if (a[3] !== undefined && luaToNumber(a[3]) === undefined) out.push(`radius "${a[3]}" is not a number (ignored by the engine)`);
  if (a.length > 5) out.push(`${a.length - 5} extra argument(s) after "optional" are ignored`);
  return out;
}

const DISPLAY_HEADER_TAGS = /^#(name|displayname|title|somname|eraname|subgroup|group|groupdisplayname)\s+\S/;

/** Per-guide checks: kinds 1, 2, 3 (except duplicates), 5, 6, 7. */
export function lintGuide(g: Guide, v: Vocab): Finding[] {
  const out: Finding[] = [];
  const callLine = g.callLine;

  // Kind 3: metadata and loadability.
  if (!g.headerTags.some((t) => t.tag === "name")) out.push(f(g, callLine, "no-name", "", "guide has no #name: it is dropped (GuideLoader.lua:809-811, :819-822)"));
  if (!g.steps.length) out.push(f(g, callLine, "no-steps", "", "guide has no step line: the Forever pre-scan and game check never run on it (GuideLoader.lua:442-444, :812)"));
  const acc = foreverAcceptance(g);
  if (!acc.loads) out.push(f(g, callLine, acc.reason!.startsWith("no #group") ? "no-group" : "not-on-forever", "", `does not load on Forever: ${acc.reason}`));

  // Header.
  for (const t of g.headerTags) {
    if (!v.headerTags.has(t.tag)) out.push(f(g, t.line, "unknown-header-tag", "#" + t.tag, `unknown header tag #${t.tag}`, sugg("#", t.tag, v.headerTags)));
    if (t.cond !== undefined) condFindings(g, t.line, t.cond, v, out);
    if (t.tag === "defaultfor" && t.value.trim() !== "58Boost") {
      for (const p of checkCondition(t.value, v.cond)) out.push(f(g, t.line, "condition", p.token, `#defaultfor: ${p.message}`, p.suggestion));
    }
  }
  for (const b of g.bareConds) condFindings(g, b.line, b.cond, v, out);

  // Steps.
  for (const s of g.steps) {
    if (s.cond !== undefined) condFindings(g, s.line, s.cond, v, out);
    for (const b of s.body) {
      if (b.cond !== undefined) condFindings(g, b.line, b.cond, v, out);
      if (b.stepTag && !v.stepTags.has(b.stepTag.tag)) out.push(f(g, b.line, "unknown-step-tag", "#" + b.stepTag.tag, `unknown step tag #${b.stepTag.tag}`, sugg("#", b.stepTag.tag, v.stepTags)));
      if (b.command) {
        const name = b.command.name;
        if (!v.commands.has(name)) out.push(f(g, b.line, "unknown-command", "." + name, `unknown command .${name}`, sugg(".", name, v.commands)));
        else if (GOTO_COMMANDS.has(name)) for (const p of gotoProblems(b.command.args)) out.push(f(g, b.line, "goto-syntax", `.${name} ${b.command.args}`, p));
      }
    }
  }

  // Kind 7: "--" cutting display text.
  const firstStepLine = g.steps[0]?.line.line ?? Infinity;
  for (const l of g.rawLines) {
    if (l.cut === undefined) continue;
    const prefix = l.raw.slice(0, l.cut);
    if (prefix.includes("<<")) continue; // a comment after the condition
    const p = prefix.trim();
    const inStep = l.line > firstStepLine;
    const isText = inStep ? prefix.includes(">>") || /^[+*]./.test(p) : DISPLAY_HEADER_TAGS.test(p);
    if (isText) out.push(f(g, l, "reserved-sequence", "--" + l.raw.slice(l.cut + 2).trim(), "\"--\" in display text starts a comment: the rest of the line is cut (GuideLoader.lua:751); put notes on their own line"));
  }
  return out;
}

function sugg(prefix: string, word: string, vocab: Set<string>): string | undefined {
  const s = nearest(word, vocab);
  return s === undefined ? undefined : prefix + s;
}

interface Entry {
  guide: Guide;
  scope: Scope;
}

/**
 * Cross-guide checks over the guides that load on Forever: duplicate
 * group||name (the key of addon.guides, GuideLoader.lua:159, :195-198), and
 * #next targets (functions.lua:3826-3935).
 */
export function crossGuide(loaded: Guide[]): Finding[] {
  const out: Finding[] = [];
  const index = new Map<string, Entry[]>();
  const displayName = new Map<string, string>(); // group -> #groupdisplayname
  for (const g of loaded) {
    const scope = guideScope(g);
    const dn = firstTag(g, "groupdisplayname")?.value.trim();
    for (const gv of groupVariants(g)) {
      if (dn && dn !== gv.value && !displayName.has(gv.value)) displayName.set(gv.value, dn);
      for (const nv of nameVariants(g)) {
        const factions = intersect(gv.factions, nv.factions);
        if (!factions.size) continue;
        const key = `${gv.value}||${nv.value}`;
        const s: Scope = { locale: scope.locale, factions };
        const list = index.get(key) ?? [];
        const clash = list.find((e) => e.guide !== g && scopesOverlap(e.scope, s));
        if (clash) out.push(f(g, firstTag(g, "name")!.line, "duplicate-name", key, `duplicate guide ${key}: also registered at ${clash.guide.file}:${clash.guide.callLine}; the later one replaces it`));
        if (!list.some((e) => e.guide === g)) list.push({ guide: g, scope: s });
        index.set(key, list);
      }
    }
  }

  const exists = (group: string, name: string, s: Scope) => (index.get(`${group}||${name}`) ?? []).some((e) => scopesOverlap(e.scope, s));
  const resolve = (group: string, name: string, s: Scope): boolean => {
    if (exists(group, name, s)) return true;
    const dn = displayName.get(group); // condenseGroups fallback, functions.lua:3873-3885
    if (dn) for (const [grp, d] of displayName) if (d === dn && exists(grp, name, s)) return true;
    return false;
  };

  for (const g of loaded) {
    const scope = guideScope(g);
    const classicSwap = !!firstTag(g, "classic"); // GroupOverride strips "group\" from #next for #classic guides in RestedXP faction groups (GuideLoader.lua:972-989, :1021)
    const reported = new Set<string>();
    for (const t of g.headerTags.filter((x) => x.tag === "next")) {
      const nf = intersect(scope.factions, conditionFactions(t.cond));
      for (const gv of groupVariants(g)) {
        const factions = intersect(nf, gv.factions);
        if (!factions.size) continue;
        const s: Scope = { locale: scope.locale, factions };
        let value = t.value;
        if (classicSwap && /RestedXP [AH][lo][lr][id][ea]\w*/.test(gv.value)) value = value.replace(/[^;]*?\\/g, "");
        let group = gv.value;
        // `for guideName in gmatch(n, "%s*([^;]+)%s*")`: leading blanks skipped, trailing kept.
        for (const raw of value.split(";")) {
          const entry = raw.replace(/^\s+/, "");
          if (!entry) continue;
          let name = entry;
          const gm = /^\s*(.+)\\\s*/.exec(entry);
          if (gm) {
            group = gm[1]!;
            name = entry.slice(gm[0].length);
          }
          name = padName(name);
          if (resolve(group, name, s)) continue;
          const token = entry.trim();
          if (reported.has(token)) continue;
          reported.add(token);
          const trailing = name !== name.trimEnd() && resolve(group, name.trimEnd(), s);
          out.push(
            f(g, t.line, "dead-next", token, trailing
              ? `#next "${token}": the space before ";" is kept in the name, so the lookup of "${group}||${name}" fails`
              : `#next "${token}": no guide "${group}||${name}" loads on Forever${s.factions.size < 2 ? ` for ${[...s.factions].map((x) => (x === "A" ? "Alliance" : "Horde")).join("")}` : ""}${s.locale !== "all" ? ` (locale scope ${s.locale})` : ""}`),
          );
        }
      }
    }
  }
  return out;
}

/** Fields of the header comment required on files under Guides/wf/ (CLAUDE.md, "Working agreements"). */
export const WF_HEADER_FIELDS: { field: string; keys: RegExp; valid?: RegExp; hint: string }[] = [
  { field: "Levels", keys: /^(levels?|level range)$/i, valid: /^\d{1,2}\s*-\s*\d{1,2}$/, hint: "e.g. \"Levels: 1-6\"" },
  { field: "Faction", keys: /^faction$/i, hint: "e.g. \"Faction: Horde\"" },
  { field: "Race", keys: /^races?$/i, hint: "e.g. \"Race: Troll, Orc\" or \"Race: any\"" },
  { field: "Class", keys: /^(class|classes|class conditions)$/i, hint: "e.g. \"Class: Warrior\" or \"Class: any\"" },
  { field: "STATUS", keys: /^status$/i, valid: /^(VERIFIED|DRAFT)$/, hint: "\"STATUS: VERIFIED\" or \"STATUS: DRAFT\"" },
  { field: "Sources", keys: /^sources?$/i, hint: "e.g. \"Sources: recording 2026-11-20\"" },
  { field: "Date", keys: /^date$/i, valid: /^\d{4}-\d{2}-\d{2}$/, hint: "\"Date: YYYY-MM-DD\"" },
];

/**
 * Kind 8: the header comment at the top of a Guides/wf/ file. The comment is
 * the run of `--` lines (or one `--[[ ... ]]` block) before the first code
 * line; it must hold one "Key: value" line per field in WF_HEADER_FIELDS.
 */
export function checkWfHeader(file: string, src: string): Finding[] {
  const lines = src.split(/\r\n|\r|\n/);
  const comment: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (lines[i]?.trim().startsWith("--[[") || lines[i]?.trim().startsWith("--[=")) {
    for (; i < lines.length; i++) {
      comment.push(lines[i]!.replace(/^\s*--\[=*\[/, ""));
      if (/\]=*\]/.test(lines[i]!)) break;
    }
  } else {
    for (; i < lines.length && lines[i]!.trim().startsWith("--"); i++) comment.push(lines[i]!.trim().replace(/^--+/, ""));
  }
  const mk = (token: string, message: string): Finding => ({ file, line: 1, kind: "wf-header", guide: "", token, message });
  if (!comment.length) return [mk("header", "missing header comment at the top of the file (Levels, Faction, Race, Class, STATUS, Sources, Date)")];
  const kv = new Map<string, string>();
  for (const c of comment) {
    const m = /^\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(.*?)\s*(\]=*\])?\s*$/.exec(c);
    if (m) for (const fld of WF_HEADER_FIELDS) if (fld.keys.test(m[1]!) && !kv.has(fld.field)) kv.set(fld.field, m[2]!);
  }
  const out: Finding[] = [];
  for (const fld of WF_HEADER_FIELDS) {
    const val = kv.get(fld.field);
    if (val === undefined || val === "") out.push(mk(fld.field, `header comment lacks ${fld.field} (${fld.hint})`));
    else if (fld.valid && !fld.valid.test(val)) out.push(mk(fld.field, `header comment ${fld.field} "${val}" is not valid (${fld.hint})`));
  }
  return out;
}
