import { test } from "node:test";
import assert from "node:assert/strict";
import { compareToBaseline, lintSources, toBaseline } from "./index.ts";
import { checkCondition, conditionFactions } from "./conditions.ts";
import { extractGuides, luaToNumber, padName } from "./parse.ts";
import { checkWfHeader, fileScope, gotoProblems, type Finding, type Vocab } from "./rules.ts";
import { classesAndRacesFrom, extractCommands, gamesFrom, loadTags, localesFrom } from "./vocab.ts";

const tags = loadTags();
const vocab: Vocab = {
  headerTags: new Set(tags.headerTags.map((t) => t.tag)),
  stepTags: new Set(tags.stepTags.map((t) => t.tag)),
  commands: new Set(["goto", "groundgoto", "accept", "turnin", "complete", "target"]),
  cond: {
    classes: new Set(["WARRIOR", "MAGE"]),
    races: new Set(["Troll", "Orc", "Scourge"]),
    games: new Set(["FOREVER", "CLASSIC", "RETAIL"]),
    locales: new Set(["enUS", "deDE"]),
    extras: new Set(["Skyborne"]),
  },
};

/** One-guide Lua file. */
function file(header: string, steps: string, prelude = ""): string {
  return `${prelude}RXPGuides.RegisterGuide([[\n${header}\n\nstep\n${steps}\n]])\n`;
}
const HDR = "#forever\n<< Horde\n#name 1-6 Test\n#group G";
const lint = (src: string, path = "Guides/t.lua") => lintSources([{ path, src }], vocab).findings;
const kinds = (fs: Finding[]) => fs.map((f) => `${f.kind}:${f.token}`);

test("extractGuides: file line numbers, several guides, two-argument form", () => {
  const src = [
    "local faction = UnitFactionGroup(\"player\")", // 1
    "if faction == \"Alliance\" then return end", // 2
    "RXPGuides.RegisterGuide([[", // 3
    "#forever", // 4
    "#name A -- note", // 5
    "#group G", // 6
    "step", // 7
    "    .goto 1411/1,-1,2", // 8
    "]])", // 9
    "-- RXPGuides.RegisterGuide([[ #name commented ]])", // 10
    "RXPGuides.RegisterGuide(\"Grp\", [[", // 11
    "#name B", // 12
    "step << Warrior", // 13
    "]])", // 14
  ].join("\r\n");
  const gs = extractGuides("f.lua", src);
  assert.equal(gs.length, 2);
  const [a, b] = gs as [NonNullable<(typeof gs)[0]>, NonNullable<(typeof gs)[0]>];
  assert.equal(a.callLine, 3);
  assert.deepEqual(a.headerTags.map((t) => [t.tag, t.value, t.line.line]), [["forever", "", 4], ["name", "A", 5], ["group", "G", 6]]);
  assert.equal(a.steps[0]!.line.line, 7);
  assert.equal(a.steps[0]!.body[0]!.line.line, 8);
  assert.deepEqual(a.steps[0]!.body[0]!.command, { name: "goto", args: "1411/1,-1,2" });
  assert.match(a.prelude, /faction == "Alliance"/);
  assert.equal(b.twoArg, true);
  assert.equal(b.groupArg, "Grp");
  assert.equal(b.steps[0]!.cond, "Warrior");
  assert.equal(b.steps[0]!.line.line, 13);
});

test("comment stripping follows the engine: needs a following line break", () => {
  const src = "RXPGuides.RegisterGuide([[\n#name X\nstep\n    >>Text --cut\n    *last --kept]])";
  const g = extractGuides("f.lua", src)[0]!;
  assert.equal(g.steps[0]!.body[0]!.displayText, "Text");
  assert.equal(g.steps[0]!.body[1]!.line.text, "*last --kept");
});

test("parseLine order: << before #tag, >> before .command", () => {
  const g = extractGuides("f.lua", file(HDR, "    .accept 123 >>Accept it << Troll\n    #completewith next << Mage"))[0]!;
  const [l1, l2] = g.steps[0]!.body;
  assert.deepEqual([l1!.command?.name, l1!.displayText, l1!.cond], ["accept", "Accept it", "Troll"]);
  assert.deepEqual([l2!.stepTag?.tag, l2!.stepTag?.value, l2!.cond], ["completewith", "next", "Mage"]);
});

test("kind 1: unknown header and step tags, with suggestions", () => {
  const fs = lint(file(HDR + "\n#nxet 2-3 Other\n#sofcore", "    #completwith next\n    #requires a\n    #sticky"));
  const k = fs.filter((f) => f.kind.startsWith("unknown"));
  assert.deepEqual(kinds(k), ["unknown-header-tag:#nxet", "unknown-header-tag:#sofcore", "unknown-step-tag:#completwith"]);
  assert.deepEqual(k.map((f) => f.suggestion), ["#next", "#softcore", "#completewith"]);
  assert.deepEqual(k.map((f) => f.line), [6, 7, 10]);
});

test("kind 2: unknown command; known ones pass", () => {
  const fs = lint(file(HDR, "    .acept 1 >>Accept\n    .accept 1\n    .events x"));
  assert.deepEqual(kinds(fs), ["unknown-command:.acept", "unknown-command:.events"]);
  assert.equal(fs[0]!.suggestion, ".accept");
});

test("kind 3: name, group, steps, Forever game rule", () => {
  assert.deepEqual(kinds(lint(file("#forever\n#group G", "    .accept 1"))), ["no-name:"]);
  assert.deepEqual(kinds(lint(file("#forever\n#name X", "    .accept 1"))), ["no-group:"]);
  assert.deepEqual(kinds(lint("RXPGuides.RegisterGuide([[\n#forever\n#name X\n#group G\n]])")), ["no-steps:"]);
  // #classic only: the Forever pre-scan needs "#FOREVER" in a header line.
  assert.deepEqual(kinds(lint(file("#classic\n#name X\n#group G", "    .accept 1"))), ["not-on-forever:"]);
  // A conditional #forever line counts (the condition is per character).
  assert.deepEqual(kinds(lint(file("#forever << Horde\n#name X\n#group G", "    .accept 1"))), []);
  // Upper case passes the pre-scan (substring search on the uppercased line); the tag itself is unknown.
  assert.deepEqual(kinds(lint(file("#FOREVER\n#name X\n#group G", "    .accept 1"))), ["unknown-header-tag:#FOREVER"]);
  // #tbc + #forever: forever makes it compatible.
  assert.deepEqual(kinds(lint(file("#forever\n#tbc\n#name X\n#group G", "    .accept 1"))), []);
  // #forever + #wotlk only would also pass; #wotlk without #forever/#classic fails the pre-scan.
  assert.deepEqual(kinds(lint(file("#wotlk\n#name X\n#group G", "    .accept 1"))), ["not-on-forever:"]);
  // Two-argument form skips the pre-scan: #classic is accepted at parse time.
  assert.deepEqual(kinds(lint('RXPGuides.RegisterGuide("G", [[\n#classic\n#name X\nstep\n    .accept 1\n]])')), []);
});

test("kind 3: duplicate group||name only when scopes overlap", () => {
  const g = (name: string, prelude = "", extra = "") => file(`#forever\n${extra}#name ${name}\n#group G`, "    .accept 1", prelude);
  const dup = lintSources([{ path: "Guides/a.lua", src: g("1-6 X") }, { path: "Guides/b.lua", src: g("01-06 X") }], vocab).findings;
  assert.deepEqual(kinds(dup), ["duplicate-name:G||01-06 X"]);
  assert.equal(dup[0]!.file, "Guides/b.lua");
  const horde = 'if faction == "Alliance" then return end\n';
  const alli = 'if faction == "Horde" then return end\n';
  assert.deepEqual(kinds(lintSources([{ path: "Guides/a.lua", src: g("X", horde) }, { path: "Guides/b.lua", src: g("X", alli) }], vocab).findings), []);
  assert.deepEqual(kinds(lintSources([{ path: "Guides/a.lua", src: g("X", "", "<< Horde\n") }, { path: "Guides/b.lua", src: g("X", "", "<< Alliance\n") }], vocab).findings), []);
  const de = 'if GetLocale() ~= "deDE" then return end\n';
  const en = "local L = GetLocale() if L and RXP.enabledLocale[L] then return end\n";
  assert.deepEqual(kinds(lintSources([{ path: "Guides/a.lua", src: g("X", en) }, { path: "lang/Guides-deDE/a.lua", src: g("X", de) }], vocab).findings), []);
});

test("kind 4: #next resolution (padding, group\\name, carry-over, trailing space, condensed groups)", () => {
  const guide = (name: string, group: string, next?: string, extra = "") =>
    `RXPGuides.RegisterGuide([[\n#forever\n#name ${name}\n#group ${group}\n${extra}${next ? `#next ${next}\n` : ""}step\n    .accept 1\n]])\n`;
  const src =
    guide("1-6 A", "G", "6-10 B") + // padded match "06-10 B"
    guide("6-10 B", "G", "H\\1-2 C; 3-4 D") + // group carried over: H||03-04 D
    guide("1-2 C", "H") +
    guide("3-4 D", "H", "Missing ;1-6 A") + // "Missing " dead; "01-06 A" not in H -> dead
    guide("5-6 E", "G", "1-6 A ;6-10 B") + // trailing space kept: "01-06 A " fails
    guide("7-8 F", "K", "1-2 C", "#groupdisplayname Shared\n") +
    guide("9-9 Z", "H", undefined, "#groupdisplayname Shared\n");
  const fs = lint(src).filter((f) => f.kind === "dead-next");
  assert.deepEqual(kinds(fs), ["dead-next:Missing", "dead-next:1-6 A", "dead-next:1-6 A"]);
  assert.match(fs[2]!.message, /space before ";"/);
});

test("kind 4: conditional #next and #group variants per faction", () => {
  const src = [
    "RXPGuides.RegisterGuide([[\n#forever\n#name 1-9 S\n#group GA << Alliance\n#group GH << Horde\n#next 9-13 S\nstep\n    .accept 1\n]])",
    "RXPGuides.RegisterGuide([[\n#forever\n<< Alliance\n#name 9-13 S\n#group GA\nstep\n    .accept 1\n]])",
  ].join("\n");
  const fs = lint(src).filter((f) => f.kind === "dead-next");
  assert.equal(fs.length, 1);
  assert.match(fs[0]!.message, /GH\|\|09-13 S.*for Horde/);
});

test("kind 5: condition keywords and structure", () => {
  const p = (c: string) => checkCondition(c, vocab.cond).map((x) => x.token + (x.suggestion ? "->" + x.suggestion : ""));
  assert.deepEqual(p("Troll Warrior/Orc !Mage"), []);
  assert.deepEqual(p("warrior FOREVER forever 10 !Undead Skyborne deDE SoD Male Horde"), []);
  assert.deepEqual(p("troll"), ["troll->Troll"]);
  assert.deepEqual(p("Trol"), ["Trol->Troll"]);
  assert.deepEqual(p("DF"), ["DF"]);
  assert.deepEqual(p("(Warrior/Mage) Troll"), []);
  assert.equal(p("(Warrior/Mage)Troll").length, 1);
  assert.equal(p("(Warrior").length, 1);
  assert.equal(p("((Warrior))").length, 1);
  assert.deepEqual(p("  "), [""]);
  assert.equal(p("Horde << Troll").length, 1);
  assert.deepEqual([...conditionFactions("Troll/Orc")].sort(), ["A", "H"]);
  assert.deepEqual([...conditionFactions("Horde Troll/!Alliance")], ["H"]);
  // In a guide: step, line, header, bare and #defaultfor conditions.
  const fs = lint(file(HDR + "\n#defaultfor Trol/Orc\n#subgroup X << Alliance", "    .accept 1 << skip\n#sticky << Hordee"));
  assert.deepEqual(kinds(fs), ["condition:Trol", "condition:skip", "condition:Hordee"]);
  assert.deepEqual(kinds(lint(file(HDR + "\n#defaultfor 58Boost", "    .accept 1"))), []);
});

test("kind 6: .goto forms (syntax only)", () => {
  assert.deepEqual(gotoProblems("Durotar,43.29,68.53"), []);
  assert.deepEqual(gotoProblems("2521,42.82,23.41,30,0"), []);
  assert.deepEqual(gotoProblems("1411/1,-4251.46,-607.35"), []);
  assert.deepEqual(gotoProblems("1421/0, 1593.60 ,597.91,15,0"), []);
  assert.equal(gotoProblems("1411/1,-4214.45,-623.92.00").length, 1);
  assert.equal(gotoProblems("Durotar,43.2").length, 1);
  assert.equal(gotoProblems("Durotar,143.2,50").length, 1); // percent form out of range
  assert.equal(gotoProblems("Durotar,43,50,far").length, 1);
  assert.equal(gotoProblems("1421/0,1,2,50,0,0").length, 1);
  assert.equal(gotoProblems("1411/1x,1,2").length, 1);
  assert.equal(gotoProblems("").length, 1);
  const fs = lint(file(HDR, "    .goto 1411/1,1,2,3,0--c:Durotar,1,2\n    .groundgoto Durotar,1"));
  assert.deepEqual(kinds(fs), ["goto-syntax:.groundgoto Durotar,1"]);
  assert.equal(fs[0]!.line, 9);
});

test("kind 7: -- in display text; >> swallowed by <<", () => {
  const fs = lint(file(HDR + "\n#displayname Foo -- bar", "    >>Kill the boar -- then loot\n    .goto 1411/1,1,2--c:Durotar\n    +Do it--now\n    .accept 1 << Horde -- note\n    .accept 2 << Troll >>Accept\n    --just a comment"));
  assert.deepEqual(kinds(fs), ["reserved-sequence:--bar", "reserved-sequence:--then loot", "reserved-sequence:--now", "reserved-sequence:<< … >>Accept"]);
});

test("kind 8: Guides/wf header comment", () => {
  const good = "-- Wayfinder guide\n-- Levels: 1-6\n-- Faction: Horde\n-- Race: Troll\n-- Class: Warrior\n-- STATUS: DRAFT\n-- Sources: recording 2026-11-20\n-- Date: 2026-11-17\n";
  assert.deepEqual(checkWfHeader("Guides/wf/a.lua", good), []);
  const block = "--[[\nLevels: 1-6\nFaction: Horde\nRace: any\nClass conditions: any\nSTATUS: VERIFIED\nSources: dump\nDate: 2026-11-17\n]]\n";
  assert.deepEqual(checkWfHeader("Guides/wf/a.lua", block), []);
  assert.deepEqual(kinds(checkWfHeader("Guides/wf/a.lua", "RXPGuides.RegisterGuide([[ ]])")), ["wf-header:header"]);
  const bad = good.replace("DRAFT", "WIP").replace("-- Date: 2026-11-17\n", "");
  assert.deepEqual(kinds(checkWfHeader("Guides/wf/a.lua", bad)), ["wf-header:STATUS", "wf-header:Date"]);
  // In lintSources only Guides/wf/ files get the header check.
  assert.deepEqual(kinds(lint(file(HDR, "    .accept 1"), "Guides/forever/x.lua")), []);
  assert.deepEqual(kinds(lint(good + file(HDR, "    .accept 1"), "Guides/wf/x.lua")), []);
});

test("extractCommands: definitions on addon.functions only", () => {
  const src = [
    "local _, addon = ...",
    "addon.functions.__index = addon.functions",
    "addon.functions.events = events",
    "function addon.functions.accept(self, ...) end",
    "addon.functions.noop = function() end",
    'addon.functions["goto"] = function(self, ...) end',
    "addon.functions.acceptmultiple = addon.functions.accept",
    "-- function addon.functions.commented() end",
    "local x = addon.functions.accept(self)",
    "if addon.functions.x == nil then end",
    "function addon.other.fake() end",
  ].join("\n");
  const defs = extractCommands("functions.lua", src);
  assert.deepEqual(defs.map((d) => [d.name, d.line]), [["accept", 4], ["noop", 5], ["goto", 6], ["acceptmultiple", 7]]);
});

test("vocabulary readers from source text", () => {
  assert.deepEqual(classesAndRacesFrom('s["Troll"] = {\n s["WARRIOR"] = {\nx["Orc"] = {'), { classes: ["WARRIOR"], races: ["Troll"] });
  assert.deepEqual(gamesFrom('addon.game = "RETAIL"\naddon.game = "FOREVER"'), ["FOREVER", "RETAIL"]);
  assert.deepEqual(localesFrom('addon.enabledLocale = {\n ["enUS"] = false,\n -- ["koKR"] = true,\n}\nx = {["frFR"]=1}'), ["enUS", "koKR"]);
});

test("helpers: luaToNumber, padName, fileScope", () => {
  assert.equal(luaToNumber(" -4251.46 "), -4251.46);
  assert.equal(luaToNumber("1e2"), 100);
  assert.equal(luaToNumber("0x10"), 16);
  assert.equal(luaToNumber("1.2.3"), undefined);
  assert.equal(padName("1-6 Durotar"), "01-06 Durotar");
  assert.equal(padName("6-10 Durotar"), "06-10 Durotar");
  assert.equal(padName("12-22 Barrens"), "12-22 Barrens");
  assert.deepEqual([...fileScope('if faction == "Alliance" then return end').factions], ["H"]);
  assert.equal(fileScope('if GetLocale() ~= "deDE" then return end').locale, "deDE");
});

test("baseline: keyed without line numbers, counted, stale is reported", () => {
  const f = (line: number, token: string): Finding => ({ file: "a.lua", line, kind: "unknown-command", guide: "G", token, message: "m" });
  const base = toBaseline([f(1, ".x"), f(9, ".x"), f(5, ".y")]);
  assert.deepEqual(base.map((b) => [b.token, b.count]), [[".x", 2], [".y", 1]]);
  // Lines moved: still clean.
  assert.deepEqual(compareToBaseline([f(3, ".x"), f(4, ".x"), f(7, ".y")], base), { fresh: [], stale: [] });
  // One more .x is new; .y gone is stale.
  const r = compareToBaseline([f(3, ".x"), f(4, ".x"), f(8, ".x")], base);
  assert.deepEqual(r.fresh.map((x) => x.line), [8]);
  assert.deepEqual(r.stale.map((s) => [s.entry.token, s.found]), [[".y", 0]]);
});
