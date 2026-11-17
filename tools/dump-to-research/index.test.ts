import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv } from "../lib/csv.ts";
import { buildDiff, findDump, folderName, formatMoney, list, parseMoney, toCsvs } from "./convert.ts";
import { convert, loadDump } from "./index.ts";

// A SavedVariables file shaped like the client writes it (synthetic values).
const SAVED = `
WayfinderData = {
	["dump"] = {
		["meta"] = {
			["time"] = "2026-11-18 20:01:02",
			["class"] = "WARRIOR",
			["race"] = "Troll",
			["level"] = 12,
			["faction"] = "Horde",
			["interface"] = 16001,
			["build"] = { ["version"] = "1.60.1", ["build"] = "1", ["interface"] = 16001 },
			["sections"] = {
				["spells"] = { ["status"] = "ok", ["count"] = 2, ["path"] = "C_SpellBook.GetSpellBookItemInfo", ["seconds"] = 0.5 },
				["talents"] = { ["status"] = "missing", ["detail"] = "GetTalentInfo" },
			},
		},
		["spells"] = {
			{ ["id"] = 101, ["name"] = "Shout", ["subtext"] = "Rank 1", ["source"] = "spellbook",
			  ["costs"] = { { ["type"] = 1, ["name"] = "RAGE", ["cost"] = 10 } },
			  ["tooltip"] = { { ["l"] = "Shout", ["r"] = "Rank 1" }, { ["l"] = "10 Rage" } } },
			{ ["id"] = 102, ["name"] = "Shout", ["subtext"] = "Rank 2", ["source"] = "seed", ["costs"] = "none" },
			{ ["id"] = 103, ["name"] = "Strike", ["subtext"] = "Rank 1", ["costs"] = { { ["cost"] = "secret" } } },
		},
		["trainer"] = {
			["4242"] = {
				["npcId"] = 4242, ["uiMapID"] = 10, ["x"] = 42.3, ["y"] = 67.9,
				["filters"] = { ["available"] = 1, ["used"] = false },
				["services"] = {
					{ ["index"] = 1, ["name"] = "Shout", ["rank"] = "Rank 2", ["category"] = "available",
					  ["levelReq"] = 12, ["cost"] = 1000, ["spellId"] = 102, ["spellIdSource"] = "spellbook" },
				},
			},
		},
		["items"] = {
			{ ["source"] = "equipped", ["slot"] = 16, ["itemID"] = 2001, ["name"] = "Blade", ["quality"] = 2, ["itemLevel"] = 10,
			  ["requiredLevel"] = 5, ["stats"] = { ["ITEM_MOD_STRENGTH_SHORT"] = 3, ["RESISTANCE0_NAME"] = 40 } },
			{ ["source"] = "seed", ["itemID"] = 2002, ["cached"] = false },
		},
		["stats"] = {
			["primary"] = { { ["index"] = 1, ["base"] = 21, ["effective"] = 23 } },
			["healthMax"] = "secret",
			["naked"] = false,
			["equippedSlots"] = { 16 },
		},
		["maps"] = {
			{ ["uiMapID"] = 2301, ["mapName"] = "Riverlands", ["zoneText"] = "Riverlands", ["subZoneText"] = "", ["mapType"] = 3 },
			{ ["uiMapID"] = 2302, ["mapName"] = "Elsewhere", ["zoneText"] = "Elsewhere" },
		},
	},
}
WayfinderCharData = nil
`;

const RESEARCH: Record<string, string[][]> = {
  "spell-ids": parseCsv(
    "row,Ability,Rank,Spell ID,Learn level,Trainer cost\n2,Shout,1,101,1,10c\n3,Shout,2,102,14,1s\n4,Strike,2,103,4,10c\n5,Gone,1,999,1,1c\n",
  ),
  "class-abilities": parseCsv('row,Class,Ability,Ranks,Learn levels (by rank),Spell IDs (by rank),Trainer costs (by rank)\n2,X,Shout,2,"1, 12","101, 102","1c, 10s"\n'),
  "quest-rewards": parseCsv('row,Zone,Item ID,Item,Quality,Item level,Slot,Stats\n2,Z,2001,Blade,Rare,10,Weapon,"40 armor, +4 Strength"\n3,Z,2002,Uncached,Rare,1,Ring,\n'),
  "zone-ids": parseCsv("row,Zone,Zone ID,Type\n2,Riverlands,555,Zone\n3,Nowhere,556,Zone\n"),
  trainers: parseCsv("row,Type,Name\n2,Warrior trainer,Someone\n"),
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wf-dump-"));
  const file = join(dir, "Wayfinder.lua");
  writeFileSync(file, SAVED);
  return { dir, file };
}

test("loadDump reads WayfinderData.dump from a SavedVariables file and from JSON", () => {
  const { dir, file } = fixture();
  try {
    const dump = loadDump(file);
    assert.equal(dump.meta.class, "WARRIOR");
    const json = join(dir, "d.json");
    writeFileSync(json, JSON.stringify({ WayfinderData: { dump } }));
    assert.equal(loadDump(json).meta.race, "Troll");
    assert.throws(() => findDump({ WayfinderData: {} }), /no WayfinderData\.dump/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("folderName uses the dump date, class, race and level", () => {
  assert.equal(folderName({ time: "2026-11-18 20:01:02", class: "WARRIOR", race: "Troll", level: 12 }), "2026-11-18-WARRIOR-Troll-L12");
  assert.equal(folderName({ class: "A B" }, "2026-01-01"), "2026-01-01-A_B-unknown-Lunknown");
});

test("list accepts arrays and Lua arrays with holes", () => {
  assert.deepEqual(list({ "2": "b", "1": "a", x: "no" }), ["a", "b"]);
  assert.deepEqual(list(undefined), []);
});

test("money parsing and formatting", () => {
  assert.equal(parseMoney("1g80s"), 18000);
  assert.equal(parseMoney("10c"), 10);
  assert.equal(parseMoney("60s"), 6000);
  assert.equal(parseMoney("free"), undefined);
  assert.equal(formatMoney(18000), "1g80s");
  assert.equal(formatMoney(0), "0c");
});

test("toCsvs writes one CSV per section with the expected cells", () => {
  const { dir, file } = fixture();
  try {
    const csvs = toCsvs(loadDump(file));
    assert.deepEqual(Object.keys(csvs).sort(), ["items.csv", "maps.csv", "quests.csv", "racials.csv", "spells.csv", "stats.csv", "talents.csv", "trainer.csv"]);
    const spells = parseCsv(csvs["spells.csv"]!);
    const h = spells[0]!;
    const shout = spells[1]!;
    assert.equal(shout[h.indexOf("spell_id")], "101");
    assert.equal(shout[h.indexOf("cost")], "10");
    assert.equal(shout[h.indexOf("costs")], "RAGE:10");
    assert.equal(shout[h.indexOf("tooltip")], "Shout [Rank 1] | 10 Rage");
    assert.equal(spells[2]![h.indexOf("costs")], "none");
    const trainer = parseCsv(csvs["trainer.csv"]!);
    assert.equal(trainer[1]![trainer[0]!.indexOf("cost")], "10s");
    assert.equal(trainer[1]![trainer[0]!.indexOf("npc_id")], "4242");
    const stats = parseCsv(csvs["stats.csv"]!);
    assert.deepEqual(stats.slice(1, 3), [["strength_base", "21"], ["strength_effective", "23"]]);
    assert.ok(stats.some((r) => r[0] === "health_max" && r[1] === "secret"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildDiff matches by ID and lists every disagreement with tab and row", () => {
  const { dir, file } = fixture();
  try {
    const diff = buildDiff(loadDump(file), RESEARCH);
    const keys = diff.rows.map((d) => `${d.tab}:${d.row}:${d.field}:${d.workbook}=>${d.game}`).sort();
    // class-abilities row 2 agrees with the game on every compared field.
    assert.deepEqual(keys, [
      "quest-rewards:2:quality:Rare=>Uncommon",
      "quest-rewards:2:stat Strength:4=>3",
      "spell-ids:3:learn level:14=>12",
      "spell-ids:3:trainer cost:1s (100)=>10s (1000)",
      "spell-ids:4:rank:2=>1",
    ]);
    const spellIds = diff.summary.find((s) => s.tab === "spell-ids")!;
    assert.deepEqual(spellIds, { tab: "spell-ids", ids: 4, seen: 3, disagreements: 3 });
    const items = diff.summary.find((s) => s.tab === "quest-rewards")!;
    assert.equal(items.seen, 1); // the uncached seed item is not compared
    assert.deepEqual(diff.zones.map((z) => [z.zone, z.areaId, z.uiMapIds]), [["Riverlands", "555", [2301]], ["Nowhere", "556", []]]);
    assert.ok(diff.notes.some((n) => n.startsWith("trainers:")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("convert writes the folder with CSVs, README and diff.md", () => {
  const { dir, file } = fixture();
  try {
    const r = convert(loadDump(file), join(dir, "game-data"), RESEARCH);
    assert.equal(r.dir, join(dir, "game-data", "2026-11-18-WARRIOR-Troll-L12"));
    assert.deepEqual(readdirSync(r.dir).sort(), [
      "README.md", "diff.md", "items.csv", "maps.csv", "quests.csv", "racials.csv", "spells.csv", "stats.csv", "talents.csv", "trainer.csv",
    ]);
    const readme = readFileSync(join(r.dir, "README.md"), "utf8");
    assert.match(readme, /\| spells \| ok \| 2 \| {2}\| 0\.5 \| C_SpellBook\.GetSpellBookItemInfo \|/);
    assert.match(readme, /\| talents \| missing \|/);
    const diff = readFileSync(join(r.dir, "diff.md"), "utf8");
    assert.match(diff, /\| spell-ids \| 3 \| 102 \| learn level \| 14 \| 12 \|/);
    assert.match(diff, /\| 2 \| Riverlands \| 555 \| 2301 \|/);
    const noResearch = convert(loadDump(file), join(dir, "other"));
    assert.equal(noResearch.diffRows, undefined);
    assert.ok(!noResearch.files.includes("diff.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
