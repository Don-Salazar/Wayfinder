import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv } from "../lib/csv.ts";
import { buildSeeds, extractIds, insertTocLine, renderSeedsLua, run } from "./index.ts";

// Synthetic CSVs shaped like the research tabs (IDs are placeholders).
const CSV = {
  "quest-rewards": "row,Zone,Item ID,Item\n2,Z,1001,A\n3,Z,,B\n4,Z,n/a,C\n5,Z,1002,D\n",
  "dungeon-loot": "row,Dungeon,Item ID,Item\n2,D,1002,D\n3,D,1003,E\n",
  "spell-ids": "row,Ability,Rank,Spell ID\n2,A,1,11\n3,A,2,12\n",
  "class-abilities": 'row,Class,Ability,Ranks,Spell IDs (by rank)\n2,C,B,3,"21, 22, 23"\n3,C,D,1,\n',
};

function fixtureRoot(withResearch: boolean, withDist = true): string {
  const root = mkdtempSync(join(tmpdir(), "wf-seeds-"));
  if (withResearch) {
    const dir = join(root, "docs/research/csv");
    mkdirSync(dir, { recursive: true });
    for (const [tab, text] of Object.entries(CSV)) writeFileSync(join(dir, `${tab}.csv`), text);
  }
  if (withDist) {
    mkdirSync(join(root, "dist/Wayfinder/Modules"), { recursive: true });
    writeFileSync(join(root, "dist/Wayfinder/Wayfinder.toc"), "## Interface: 16001\nModules/Core.lua\nModules/SelfTest.lua\n");
  }
  return root;
}

test("extractIds takes every numeric token of the ID column and skips the rest", () => {
  assert.deepEqual(extractIds(parseCsv(CSV["quest-rewards"]), /^item id$/i), [1001, 1002]);
  assert.deepEqual(extractIds(parseCsv(CSV["class-abilities"]), /^spell ids\b/i), [21, 22, 23]);
  assert.deepEqual(extractIds(parseCsv(CSV["spell-ids"]), /^item id$/i), []);
});

test("buildSeeds merges tabs into unique sorted lists", () => {
  const root = fixtureRoot(true);
  try {
    const s = buildSeeds(join(root, "docs/research/csv"));
    assert.deepEqual(s.items, [1001, 1002, 1003]);
    assert.deepEqual(s.spells, [11, 12, 21, 22, 23]);
    assert.deepEqual(s.skipped, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderSeedsLua writes the header and plain lists", () => {
  const text = renderSeedsLua({ items: [1, 2], spells: [], counts: { "spell-ids": 0 } }, "2026-11-17");
  assert.match(text, /local development seeds; single-source research; not shipped/);
  assert.match(text, /addon\.WF\.dumpSeeds = \{\n {4}items = \{\n {8}1, 2,\n {4}\},\n {4}spells = \{\n {4}\},\n\}/);
});

test("insertTocLine adds after the anchor once and keeps CRLF", () => {
  const toc = "a.lua\r\nModules/Core.lua\r\nb.lua\r\n";
  const next = insertTocLine(toc, "Modules/DumpSeeds.lua", "Modules/Core.lua");
  assert.equal(next, "a.lua\r\nModules/Core.lua\r\nModules/DumpSeeds.lua\r\nb.lua\r\n");
  assert.equal(insertTocLine(next, "Modules/DumpSeeds.lua", "Modules/Core.lua"), next);
  assert.throws(() => insertTocLine("x.lua\n", "y.lua", "Modules/Core.lua"), /not listed/);
});

test("run is a no-op without the research folder", () => {
  const root = fixtureRoot(false);
  try {
    const r = run(root);
    assert.equal(r.status, "no-research");
    assert.match(r.message, /not found/);
    assert.deepEqual(readdirSync(join(root, "dist/Wayfinder/Modules")), []);
    assert.equal(readFileSync(join(root, "dist/Wayfinder/Wayfinder.toc"), "utf8"), "## Interface: 16001\nModules/Core.lua\nModules/SelfTest.lua\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run writes the seeds file and lists it after Modules/Core.lua, idempotently", () => {
  const root = fixtureRoot(true);
  try {
    const r = run(root, "2026-11-17");
    assert.equal(r.status, "written");
    const lua = readFileSync(join(root, "dist/Wayfinder/Modules/DumpSeeds.lua"), "utf8");
    assert.match(lua, /1001, 1002, 1003,/);
    run(root, "2026-11-17");
    assert.equal(
      readFileSync(join(root, "dist/Wayfinder/Wayfinder.toc"), "utf8"),
      "## Interface: 16001\nModules/Core.lua\nModules/DumpSeeds.lua\nModules/SelfTest.lua\n",
    );
    assert.equal(existsSync(join(root, "docs/research/csv/DumpSeeds.lua")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run fails clearly when the addon has not been built", () => {
  const root = fixtureRoot(true, false);
  try {
    assert.throws(() => run(root), /build:addon/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
