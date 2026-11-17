// Vocabularies for lint-guides.
//
// - Commands (`.tag`) are extracted from SOURCE at lint time: every name
//   defined as `addon.functions.<name>` in the Lua files that load on Forever.
// - Header and step tags come from tags.json (each entry cites one reader line
//   in source; tags.test.ts checks the line still mentions the tag).
// - Condition keywords are derived from source where the source has a list
//   (classes/races, game names, locales) and encoded from the evaluator
//   otherwise; see conditionVocab below.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lexLua, type Token } from "../inventory-ids/lex.ts";

export interface TagEntry {
  tag: string;
  /** "File.lua:line" of one line in source that reads this tag. */
  reader: string;
  /** Text the reader line must contain, when not the tag itself (dynamic reads). */
  mentions?: string;
  note?: string;
}

export interface TagsFile {
  description: string;
  headerTags: TagEntry[];
  stepTags: TagEntry[];
  /** Condition tokens accepted although no source list contains them. */
  conditionExtras: { token: string; source: string; note: string }[];
}

export const TAGS_JSON = fileURLToPath(new URL("./tags.json", import.meta.url));

export function loadTags(path = TAGS_JSON): TagsFile {
  return JSON.parse(readFileSync(path, "utf8")) as TagsFile;
}

export interface CommandDef {
  name: string;
  file: string;
  line: number;
}

/**
 * Names defined on `addon.functions` in one Lua source:
 *   function addon.functions.NAME(...)
 *   addon.functions.NAME = function ...      | = addon.functions.OTHER
 *   addon.functions["NAME"] = function ...   | = addon.functions.OTHER
 * Assignments of anything else (the `events` table, the `__index`
 * self-reference at functions.lua:68/:75) are not commands: parseLine calls
 * the value (GuideLoader.lua:675-676), so a non-function fails.
 */
export function extractCommands(file: string, src: string): CommandDef[] {
  const { tokens } = lexLua(src);
  const out: CommandDef[] = [];
  let lineStarts: number[] | null = null;
  const lineOf = (off: number) => {
    if (!lineStarts) {
      lineStarts = [0];
      for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const isFunctionsRef = (i: number) => tokens[i]?.value === "addon" && tokens[i + 1]?.value === "." && tokens[i + 2]?.value === "functions";
  /** Key of `addon.functions.NAME` / `addon.functions["NAME"]` at i: [name, index after]. */
  const keyAt = (i: number): [string, number] | null => {
    if (!isFunctionsRef(i)) return null;
    const a = tokens[i + 3];
    if (a?.value === "." && tokens[i + 4]?.type === "name") return [tokens[i + 4]!.value, i + 5];
    if (a?.value === "[" && tokens[i + 4]?.type === "string" && tokens[i + 5]?.value === "]") {
      const s: Token = tokens[i + 4]!;
      return [src.slice(s.cstart!, s.cend!), i + 6];
    }
    return null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "name" && t.value === "function") {
      const k = keyAt(i + 1);
      if (k && tokens[k[1]]?.value === "(") out.push({ name: k[0], file, line: lineOf(t.start) });
      continue;
    }
    // assignment at statement level: previous token must not be "." / ":" (part of a longer expression)
    if (t.type === "name" && t.value === "addon" && tokens[i - 1]?.value !== "." && tokens[i - 1]?.value !== "function") {
      const k = keyAt(i);
      if (!k || tokens[k[1]]?.value !== "=") continue;
      const rhs = k[1] + 1;
      const r = tokens[rhs];
      const isFn = r?.value === "function" || (keyAt(rhs) !== null);
      if (isFn) out.push({ name: k[0], file, line: lineOf(t.start) });
    }
  }
  return out;
}

/** Condition vocabulary (see conditions.ts for how it is applied). */
export interface ConditionVocab {
  /** Upper-case class file tokens (compared case-insensitively). */
  classes: Set<string>;
  /** Race file tokens (compared case-sensitively). */
  races: Set<string>;
  /** Upper-case addon.game values (compared case-insensitively). */
  games: Set<string>;
  /** GetLocale() values (compared case-sensitively). */
  locales: Set<string>;
  /** Extra tokens accepted as-is (tags.json conditionExtras). */
  extras: Set<string>;
}

/**
 * Class and race tokens on Forever: the keys of the racial/class spell table
 * in DB/forever/spells.lua (`s["Troll"] = {`, `s["WARRIOR"] = {`); upper-case
 * keys are class file tokens (UnitClass 2nd return, compared with
 * strupper(token), GuideLoader.lua:60,78), the others race file tokens
 * (UnitRace 2nd return, compared case-sensitively, GuideLoader.lua:78).
 */
export function classesAndRacesFrom(src: string): { classes: string[]; races: string[] } {
  const classes = new Set<string>();
  const races = new Set<string>();
  for (const m of src.matchAll(/^\s*s\["([A-Za-z]+)"\]\s*=\s*\{/gm)) {
    const k = m[1]!;
    if (k === k.toUpperCase()) classes.add(k);
    else races.add(k);
  }
  return { classes: [...classes].sort(), races: [...races].sort() };
}

/** `addon.game = "X"` assignments (RXPGuides.lua:170-194). */
export function gamesFrom(src: string): string[] {
  return [...new Set([...src.matchAll(/addon\.game\s*=\s*"([A-Z]+)"/g)].map((m) => m[1]!))].sort();
}

/** Keys of the `addon.enabledLocale = { ... }` table, commented ones included (RXPGuides.lua:156-168). */
export function localesFrom(src: string): string[] {
  const start = src.indexOf("addon.enabledLocale = {");
  if (start < 0) return [];
  const end = src.indexOf("}", start);
  return [...new Set([...src.slice(start, end).matchAll(/\["([a-z]{2}[A-Z]{2})"\]/g)].map((m) => m[1]!))].sort();
}
