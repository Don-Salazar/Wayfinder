// `<<` condition checker, encoding `applies` (GuideLoader.lua:36-103):
//
// - Parenthesised groups `(…)` / `!(…)` are evaluated first with the lazy
//   pattern `(!?)%(%s*(.-)%s*%)` (:41) and replaced, without padding, by a
//   token that is always true or always false. So nesting is unreliable (the
//   first "(" pairs with the first ")") and a group written against a word,
//   `(A/B)C`, fuses into one token that matches nothing.
// - Alternatives split on "/" (:50); tokens inside one are `!?[%w%d]+` (:52),
//   all must hold; anything else separates tokens. "!" negates (:55-58).
// - A token holds if (:59-80): it is a number <= UnitLevel; strupper(token)
//   equals the class file token; the token equals the race file token
//   ("Undead" -> "Scourge", "Haranir" -> "Harronir"; case-sensitive); it
//   equals the faction ("Horde"/"Alliance"/"Neutral"; case-sensitive); its
//   upper case equals addon.game; "DK" -> "DEATHKNIGHT"; "MALE"/"FEMALE"
//   (case-insensitive, UnitSex); "SOD" (case-insensitive, season 2); it
//   equals GetLocale() (case-sensitive). "DF" is rewritten to entry="RETAIL"
//   but compared via the unchanged upper-case "DF", so it never matches (:70-71, :79).
//   (customClass / func arguments are not used for guide text.)
// - No tokens at all: the alternative holds (v stays true), so an empty or
//   punctuation-only condition is always true.

import { luaToNumber } from "./parse.ts";
import type { ConditionVocab } from "./vocab.ts";

export interface ConditionProblem {
  /** Offending token, or the whole condition for structural problems. */
  token: string;
  message: string;
  suggestion?: string;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

/** Nearest candidate within maxDist (ties: alphabetical), else undefined. */
export function nearest(word: string, candidates: Iterable<string>, maxDist = 2): string | undefined {
  let best: string | undefined;
  let bestD = maxDist + 1;
  for (const c of [...candidates].sort()) {
    const d = levenshtein(word, c);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return bestD <= maxDist ? best : undefined;
}

const FACTIONS = ["Horde", "Alliance", "Neutral"];
const CASELESS = ["SOD", "MALE", "FEMALE"];

function cap(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/** Spellings a guide author would write, for suggestions. */
function displayVocab(v: ConditionVocab): string[] {
  return [
    ...[...v.classes].map(cap),
    ...v.races,
    "Undead",
    ...FACTIONS,
    ...[...v.games].map((g) => (g.length <= 4 ? g : cap(g))),
    "SoD",
    "Male",
    "Female",
    ...v.locales,
    ...v.extras,
  ];
}

/** Classify one token (without "!"): undefined when the evaluator can match it. */
export function checkToken(tok: string, v: ConditionVocab): ConditionProblem | undefined {
  if (luaToNumber(tok) !== undefined) return undefined;
  const up = tok.toUpperCase();
  if (up === "DF") return { token: tok, message: `"${tok}" never matches: it is rewritten to RETAIL but compared as DF (GuideLoader.lua:70-71, :79)` };
  if (v.classes.has(up)) return undefined;
  if (up === "DK") return v.classes.has("DEATHKNIGHT") ? undefined : { token: tok, message: `"${tok}" (DEATHKNIGHT) is not a class on this game` };
  const race = tok === "Undead" ? "Scourge" : tok === "Haranir" ? "Harronir" : tok;
  if (v.races.has(race) || FACTIONS.includes(tok) || v.games.has(up) || CASELESS.includes(up) || v.locales.has(tok) || v.extras.has(tok)) return undefined;
  // Case-sensitive families written in the wrong case never match.
  const ci = [...v.races, "Undead", ...FACTIONS, ...v.locales, ...v.extras].find((x) => x.toLowerCase() === tok.toLowerCase());
  if (ci) return { token: tok, message: `"${tok}" never matches: race, faction and locale tokens are case-sensitive`, suggestion: ci };
  const s = nearest(tok, displayVocab(v));
  return { token: tok, message: `unknown condition keyword "${tok}"`, ...(s ? { suggestion: s } : {}) };
}

/** Check one condition string (the text after "<<"). */
export function checkCondition(cond: string, v: ConditionVocab): ConditionProblem[] {
  const out: ConditionProblem[] = [];
  const c = cond.trim();
  if (!/[A-Za-z0-9]/.test(c)) {
    out.push({ token: c, message: "empty condition: it has no keyword, so it is always true" });
    return out;
  }
  if (c.includes("<<")) out.push({ token: "<<", message: "a second \"<<\" inside the condition is read as a separator" });
  let depth = 0;
  let maxDepth = 0;
  let unbalanced = false;
  for (const ch of c) {
    if (ch === "(") maxDepth = Math.max(maxDepth, ++depth);
    else if (ch === ")") {
      if (--depth < 0) {
        unbalanced = true;
        depth = 0;
      }
    }
  }
  if (depth !== 0) unbalanced = true;
  if (unbalanced) out.push({ token: c, message: "unbalanced parentheses" });
  else if (maxDepth > 1) out.push({ token: c, message: "nested parentheses are not supported (the first \"(\" pairs with the first \")\")" });
  if (/\)[!A-Za-z0-9]/.test(c) || /[A-Za-z0-9]!?\(/.test(c)) out.push({ token: c, message: "a parenthesis group touching a word fuses into one token that never matches; put spaces around it" });
  if (/\(\s*\)/.test(c)) out.push({ token: c, message: "empty parentheses" });
  for (const m of c.matchAll(/!?[A-Za-z0-9]+/g)) {
    const p = checkToken(m[0].replace(/^!/, ""), v);
    if (p) out.push(p);
  }
  return out;
}

/** Factions a condition can hold for: "A", "H". Approximation: looks only at Horde/Alliance tokens per alternative. */
export function conditionFactions(cond: string | undefined): Set<"A" | "H"> {
  const all = new Set<"A" | "H">(["A", "H"]);
  if (!cond) return all;
  const out = new Set<"A" | "H">();
  let sawAlt = false;
  for (const alt of cond.replace(/[()]/g, " ").split("/")) {
    if (!/[A-Za-z0-9]/.test(alt)) continue;
    sawAlt = true;
    let f = new Set<"A" | "H">(["A", "H"]);
    for (const m of alt.matchAll(/!?[A-Za-z0-9]+/g)) {
      const t = m[0];
      if (t === "Horde" || t === "!Alliance") f = new Set([...f].filter((x) => x === "H"));
      if (t === "Alliance" || t === "!Horde") f = new Set([...f].filter((x) => x === "A"));
    }
    for (const x of f) out.add(x);
  }
  return sawAlt ? out : all;
}
