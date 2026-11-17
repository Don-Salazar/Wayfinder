import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSavedVariables } from "../read-savedvars/parse.ts";
import {
  buildReport,
  findLogs,
  linearize,
  NO_DATA,
  previousReportName,
  questRows,
  readSummary,
  splitSessions,
  type LogEvent,
  type Obj,
} from "./analyze.ts";
import { analyze, parseArgs } from "./index.ts";

// Synthetic values throughout: made-up quest, NPC and install IDs.
const ID = "0a1b2c3d4e5f";

const session = (n: number, s: number, d: string, lv: number, extra: Obj = {}): LogEvent => ({
  n, k: "session", t: 0, s, id: ID, d, lv, cl: "WARRIOR", r: "Troll", av: "0.1.0-dev", cv: "1.60.1", b: "99999",
  gd: { key: "k", name: "1-10 Test", version: 3 }, ...extra,
});

const ring = (events: LogEvent[], extra: Obj = {}): Obj => ({
  v: 1, id: ID, cap: 20000, head: 1, count: events.length, dropped: 0, events, ...extra,
});

const charLog = (log: Obj, source = "Wayfinder.lua") => findLogs({ WayfinderCharData: { log } }, source).logs;

const MULTI: LogEvent[] = [
  session(1, 1, "2026-11-18 20:00:00", 5),
  { n: 2, k: "quest_accept", t: 10, lv: 5, q: 99001, g: true, c: 99901, nm: "Test Giver" },
  { n: 3, k: "quest_accept", t: 20, lv: 5, q: 99002, g: false, c: 99902, nm: "Other Giver" },
  { n: 4, k: "quest_turnin", t: 100, lv: 5, q: 99001, xp: 450, mo: 75, g: true },
  { n: 5, k: "xp", t: 101, lv: 5, a: 450, src: "quest", s: 1 },
  { n: 6, k: "xp", t: 600, lv: 5, a: 300, src: "other", s: 4 },
  { n: 7, k: "level", t: 1800, lv: 6, nl: 6, pl: 7200 },
  { n: 8, k: "xp", t: 3600, lv: 6, a: 900, src: "other", s: 9 },
  { n: 9, k: "error", t: 3601, lv: 6, msg: "Modules/FieldLog.lua:10: boom\nmore", mod: "fieldlog", c: 3, st: "stack" },
  { n: 10, k: "note", t: 3602, lv: 6, m: 9001, x: 41.2, y: 56.8, tx: "the | arrow points wrong" },
  session(11, 2, "2026-11-19 19:00:00", 6),
  { n: 12, k: "quest_turnin", t: 50, lv: 6, q: 99002, xp: 300, g: false },
  { n: 13, k: "quest_turnin", t: 60, lv: 6, q: 99003, xp: 210 },
  { n: 14, k: "error", t: 70, lv: 6, msg: "Modules/FieldLog.lua:10: boom", mod: "fieldlog", c: 1 },
  { n: 15, k: "blocked", t: 80, lv: 6, fn: "UseAction()", ad: "Wayfinder", ev: "blocked", c: 2 },
  { n: 16, k: "probe", t: 90, lv: 6, id: "fieldlog.xp", st: "info", dt: "UnitXP/UnitXPMax secret" },
  { n: 17, k: "xp", t: 1800, lv: 6, a: 600, src: "quest", s: 2 },
];

test("linearize: a wrapped ring comes out oldest first", () => {
  const events = [
    { n: 4, k: "note" }, { n: 5, k: "note" }, { n: 3, k: "note" },
  ];
  const out = linearize({ cap: 3, head: 3, count: 3, events });
  assert.deepEqual(out.map((e) => e.n), [3, 4, 5]);
});

test("linearize: an object-shaped events table and a damaged ring fall back to sequence order", () => {
  assert.deepEqual(linearize({ cap: 1000, head: 1, count: 2, events: { "1": { n: 1, k: "a" }, "2": { n: 2, k: "b" } } }).map((e) => e.n), [1, 2]);
  const damaged = { cap: 1000, head: 7, count: 3, events: [{ n: 9, k: "a" }, { n: 2, k: "b" }, { bad: true }] };
  assert.deepEqual(linearize(damaged).map((e) => e.n), [2, 9]);
  assert.deepEqual(linearize({}), []);
});

test("splitSessions: sessions start at each session event; earlier events form session 0", () => {
  const sessions = splitSessions([{ n: 1, k: "note" }, ...MULTI]);
  assert.deepEqual(sessions.map((s) => [s.index, s.events.length]), [[0, 1], [1, 10], [2, 7]]);
  assert.equal(sessions[1]!.label, "Troll WARRIOR");
});

test("findLogs: reads the log and the self-test from SavedVariables text", () => {
  const text = `
WayfinderData = {
	["installId"] = "${ID}",
	["selftest"] = { ["status"] = "done", ["counts"] = { ["pass"] = 60, ["fail"] = 2 } },
}
WayfinderCharData = {
	["log"] = {
		["v"] = 1, ["id"] = "${ID}", ["cap"] = 1000, ["head"] = 2, ["count"] = 1000, ["dropped"] = 5,
		["events"] = {},
	},
}
`;
  const data = parseSavedVariables(text) as Obj;
  const log = (data.WayfinderCharData as Obj).log as Obj;
  const events: LogEvent[] = [];
  for (let i = 0; i < 1000; i++) events.push({ n: i === 0 ? 1005 : i + 5, k: i === 1 ? "session" : "note", t: 0 });
  log.events = events;
  const found = findLogs(data, "x.lua");
  assert.equal(found.logs.length, 1);
  assert.equal(found.logs[0]!.installId, ID);
  assert.equal(found.logs[0]!.events[0]!.n, 6);
  assert.equal(found.logs[0]!.events.at(-1)!.n, 1005);
  assert.equal(found.selftest?.status, "done");
});

test("report: an empty log still has every fixed section", () => {
  const report = buildReport({ installId: ID, logs: charLog(ring([])) });
  assert.equal(report.name, `undated-${ID}.md`);
  for (const heading of ["## 1. Errors and blocked actions", "## 2. Guide data corrections", "### Coordinate drift",
    "### Quests never offered", "### Quests the guide does not contain", "### Quest XP observed",
    "### Steps that needed a manual tick or a skip", "## 3. Pace", "### Level timeline", "## 4. Choices",
    "## 5. Research reconciliation"]) {
    assert.ok(report.markdown.includes(heading), heading);
  }
  assert.ok(report.markdown.includes(NO_DATA));
  assert.deepEqual(readSummary(report.markdown), { installId: ID, findings: [] });
  assert.ok(report.patch.includes("None at this stage"));
});

test("report: multi-session errors, missing quests, quest XP, pace and notes", () => {
  const report = buildReport({ installId: ID, logs: charLog(ring(MULTI)) });
  const md = report.markdown;
  assert.equal(report.name, `2026-11-19-${ID}.md`);
  // Errors grouped by module and first line, counts summed across sessions.
  assert.match(md, /\| fieldlog \| Modules\/FieldLog\.lua:10: boom \| 4 \| s1 t=3601s \| s2 t=70s \| #9 #14 \|/);
  assert.match(md, /\| blocked \| UseAction\(\) \| 2 \|/);
  assert.match(md, /\| fieldlog\.xp \| info \|/);
  // Only g === false counts as "not in the guide"; g missing is counted apart.
  assert.match(md, /\| 99002 \| 1 \| 1 \| NPC 99902 \(Other Giver\) \| 5, 6 \| #3 #12 \|/);
  assert.ok(!/\| 99001 \| 1 \| 1 \| NPC/.test(md));
  assert.match(md, /1 quest event\(s\) happened with no active guide/);
  assert.match(md, /\| 99001 \| 1 \| 450 \| 450 \| 5 \| #4 \|/);
  // Pace: session 1 logged 1h 00m (t=3602), 450 quest + 1200 other.
  assert.match(md, /\| 1 \| 2026-11-18 20:00:00 \| 1h 00m \| 450 \| 1200 \| 1650 \| 1649 \|/);
  // By level: level 5 for 1800 s (session 1) with 750 XP; level 6 for 1802 s + 1800 s.
  assert.match(md, /\| 5 \| 0h 30m \| 450 \| 300 \| 1500 \|/);
  assert.match(md, /\| 6 \| 1h 00m \| 600 \| 900 \| 1499 \|/);
  assert.match(md, /\| 6 \| 1 \| t=1800s \| 2h 00m \| #7 \|/);
  // Notes keep the player's words; pipes are escaped.
  assert.match(md, /\| #10 \| s1 t=3602s \| 6 \| 9001 41\.2, 56\.8 \| the \\\| arrow points wrong \|/);
  assert.deepEqual(report.findings, ["blocked:blocked:UseAction()", "error:fieldlog:Modules/FieldLog.lua:10: boom",
    "notInGuide:99002", "probe:fieldlog.xp:info"]);
});

test("report: XP per level follows a level-up inside a session", () => {
  const events: LogEvent[] = [
    session(1, 1, "2026-11-18 20:00:00", 9),
    { n: 2, k: "xp", t: 100, lv: 9, a: 850, src: "other" },
    { n: 3, k: "level", t: 120, lv: 10, nl: 10 },
    { n: 4, k: "xp", t: 121, lv: 10, a: 100, src: "other" },
    { n: 5, k: "note", t: 480, lv: 10, tx: "end" },
  ];
  const md = buildReport({ installId: ID, logs: charLog(ring(events)) }).markdown;
  assert.match(md, /\| 9 \| 0h 02m \| 0 \| 850 \| 25500 \|/);
  assert.match(md, /\| 10 \| 0h 06m \| 0 \| 100 \| 1000 \|/);
});

test("research: compares by exact quest ID, with the workbook row number", () => {
  const csv = "row,Quest ID,Quest,Level,Required level,Faction,XP,Type,Filed under\n" +
    "2,99001,A Test Quest,5,4,Horde,450,Solo,Test\n" +
    "3,99002,Another Test,6,5,Horde,\"1,250\",Solo,Test\n" +
    "4,99009,A Test Quest,5,4,Horde,999,Solo,Test\n";
  const research = questRows("riverglades-quests", csv);
  assert.deepEqual(research.map((r) => [r.row, r.questId, r.xp]), [["2", 99001, 450], ["3", 99002, 1250], ["4", 99009, 999]]);
  const md = buildReport({ installId: ID, logs: charLog(ring(MULTI)), research }).markdown;
  assert.match(md, /\| 99001 \| A Test Quest \| riverglades-quests row 2 \| 450 \| #4 \|/);
  assert.match(md, /\| 99002 \| Another Test \| riverglades-quests row 3 \| 1250 \| 300 \| 6 \| #12 \|/);
  assert.ok(!md.includes("row 4"), "a same-titled row with another ID is never matched");
  assert.match(md, /Turned in but not in the quest tabs: 99003\./);
});

test("analyze: writes report and patch, deterministic, and lists repeated findings first", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyze-log-"));
  try {
    const first = ring(MULTI.slice(0, 10));
    const [w1] = analyze([{ source: "a.lua", data: { WayfinderCharData: { log: first } } }], dir);
    assert.ok(w1);
    assert.equal(w1.again, 0);
    const firstText = readFileSync(w1.report, "utf8");
    analyze([{ source: "a.lua", data: { WayfinderCharData: { log: first } } }], dir);
    assert.equal(readFileSync(w1.report, "utf8"), firstText, "same input, same output");

    const [w2] = analyze([{ source: "b.lua", data: { WayfinderCharData: { log: ring(MULTI) } } }], dir);
    assert.ok(w2);
    assert.deepEqual(readdirSync(dir).sort(), [`2026-11-18-${ID}.md`, `2026-11-18-${ID}.patch.md`,
      `2026-11-19-${ID}.md`, `2026-11-19-${ID}.patch.md`]);
    const md = readFileSync(w2.report, "utf8");
    assert.ok(md.includes(`previous report \`2026-11-18-${ID}.md\``));
    assert.match(md, /\| \*\*again\*\* \| fieldlog \| Modules\/FieldLog\.lua:10: boom \|/);
    assert.equal(w2.again, 2); // the error and quest 99002 were in the first report
    const missing = md.slice(md.indexOf("### Quests the guide does not contain"));
    assert.ok(missing.indexOf("**again**") < missing.indexOf("| 99002"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("previousReportName picks the latest earlier report for the same install only", () => {
  const names = [`2026-11-10-${ID}.md`, `2026-11-12-${ID}.md`, `2026-11-12-${ID}.patch.md`, "2026-11-13-ffffffffffff.md",
    `2026-11-14-${ID}.md`];
  assert.equal(previousReportName(names, ID, `2026-11-14-${ID}.md`), `2026-11-12-${ID}.md`);
  assert.equal(previousReportName(names, ID, `2026-11-10-${ID}.md`), undefined);
});

test("parseArgs", () => {
  assert.equal(parseArgs([]), "give at least one SavedVariables file");
  assert.equal(parseArgs(["a.lua", "--bogus"]), "unknown option --bogus");
  assert.equal(parseArgs(["a.lua", "--out"]), "--out needs a value");
  const args = parseArgs(["a.lua", "b.lua", "--out", "x"]);
  assert.ok(typeof args !== "string");
  assert.deepEqual(args.files, ["a.lua", "b.lua"]);
});
