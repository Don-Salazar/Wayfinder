import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileIndex } from "../check-manifests/manifest.ts";
import { buildToc, pathKey, sameText, shippedFiles, validateConfig, type TocConfig } from "./index.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function cfg(over: Partial<TocConfig> = {}): TocConfig {
  return {
    upstreamToc: "Up.toc",
    output: "Way.toc",
    addon: "Way",
    gameType: "camelot",
    header: { Interface: "16001", Title: "Way", SavedVariables: "inherit" },
    drop: [],
    ship: { extraFiles: [], assetDirs: [] },
    ...over,
  };
}

const UP = [
  "## Interface: 11509, 16001",
  "## Interface-TBC: 20506",
  "## Title: Upstream",
  "## SavedVariables: UpDB, UpSettings",
  "## X-Curse-Project-ID: 1",
  "",
  "libs\\embeds_Mainline.xml [AllowLoadGameType standard,camelot]",
  "libs\\embeds.xml [AllowLoadGameType vanilla,tbc]",
  "Core.lua",
  "#lang/off.xml [AllowLoadGameType camelot]",
  "DB/forever.xml [AllowLoadGameType camelot]",
  "Talents.lua [AllowLoadGameType cata,vanilla,Forever]",
  "Mists.lua [ExcludeLoadGameType camelot]",
  "Std.lua [ExcludeLoadGameType standard]",
].join("\r\n");

test("buildToc: keeps camelot lines in order, untagged; header from config", () => {
  const r = buildToc(UP, cfg(), SHA);
  assert.deepEqual(r.files, ["libs\\embeds_Mainline.xml", "Core.lua", "DB/forever.xml", "Talents.lua", "Std.lua"]);
  const lines = r.text.split("\n");
  assert.match(lines[0]!, /^# GENERATED FILE .*Up\.toc.*0123456789abcdef0123456789abcdef01234567/);
  assert.deepEqual(lines.slice(1, 5), ["## Interface: 16001", "## Title: Way", "## SavedVariables: UpDB, UpSettings", ""]);
  assert.ok(!/X-Curse|Interface-TBC|Upstream|\[/.test(r.text));
  assert.ok(r.text.endsWith("Std.lua\n"));
});

test("buildToc: drop is case- and slash-insensitive and must match a kept line", () => {
  const r = buildToc(UP, cfg({ drop: [{ path: "db\\FOREVER.xml", reason: "test" }] }), SHA);
  assert.deepEqual(r.files, ["libs\\embeds_Mainline.xml", "Core.lua", "Talents.lua", "Std.lua"]);
  assert.deepEqual(r.dropped.map((d) => d.path), ["db\\FOREVER.xml"]);
  // Matches only a line that does not load on camelot: stale.
  assert.throws(() => buildToc(UP, cfg({ drop: [{ path: "libs/embeds.xml", reason: "x" }] }), SHA), /stale/);
  assert.throws(() => buildToc(UP, cfg({ drop: [{ path: "gone.lua", reason: "x" }] }), SHA), /gone\.lua/);
});

test("buildToc: insert places our files after a kept line, in config order", () => {
  const r = buildToc(
    UP,
    cfg({
      insert: [
        { path: "Modules/A.lua", after: "core.LUA", reason: "a" },
        { path: "Modules/B.lua", after: "Core.lua", reason: "b" },
        { path: "Modules/C.lua", after: "modules\\b.lua", reason: "c" },
        { path: "Modules/Z.lua", after: "Std.lua", reason: "z" },
      ],
    }),
    SHA,
  );
  assert.deepEqual(r.files, ["libs\\embeds_Mainline.xml", "Core.lua", "Modules/A.lua", "Modules/B.lua", "Modules/C.lua", "DB/forever.xml", "Talents.lua", "Std.lua", "Modules/Z.lua"]);
  assert.deepEqual(r.inserted.map((i) => i.path), ["Modules/A.lua", "Modules/B.lua", "Modules/C.lua", "Modules/Z.lua"]);
  assert.ok(r.text.includes("Core.lua\nModules/A.lua\nModules/B.lua\nModules/C.lua\nDB/forever.xml\n"));
  // Anchor on a dropped line, a line not loading on camelot, or a missing file: stale.
  assert.throws(() => buildToc(UP, cfg({ drop: [{ path: "Core.lua", reason: "x" }], insert: [{ path: "M.lua", after: "Core.lua", reason: "x" }] }), SHA), /not a kept camelot line/);
  assert.throws(() => buildToc(UP, cfg({ insert: [{ path: "M.lua", after: "Mists.lua", reason: "x" }] }), SHA), /Mists\.lua/);
  // Inserting a file the TOC already loads.
  assert.throws(() => buildToc(UP, cfg({ insert: [{ path: "talents.lua", after: "Core.lua", reason: "x" }] }), SHA), /already a line/);
  // No insert key at all is fine.
  assert.deepEqual(buildToc(UP, cfg(), SHA).inserted, []);
});

test("validateConfig: insert entries", () => {
  assert.doesNotThrow(() => validateConfig(cfg({ insert: [{ path: "M.lua", after: "Core.lua", reason: "r" }] })));
  assert.throws(() => validateConfig(cfg({ insert: [{ path: "M.lua", after: "Core.lua", reason: "" }] })), /reason/);
  assert.throws(() => validateConfig(cfg({ insert: [{ path: "M.lua", after: " ", reason: "r" }] })), /after/);
  assert.throws(() => validateConfig(cfg({ insert: [{ path: "M.lua", after: "A.lua", reason: "r" }, { path: "m.LUA", after: "B.lua", reason: "r" }] })), /twice/);
  assert.throws(() => validateConfig(cfg({ drop: [{ path: "M.lua", reason: "r" }], insert: [{ path: "M.lua", after: "A.lua", reason: "r" }] })), /drop/);
  assert.throws(() => validateConfig(cfg({ insert: [{ path: "M.lua", after: "m.lua", reason: "r" }] })), /itself/);
  assert.throws(() => validateConfig(cfg({ insert: {} as unknown as [] })), /array/);
});

test("buildToc: inherit needs the upstream line; risky directives fail", () => {
  const plain = cfg({ header: { Interface: "16001" } });
  assert.throws(() => buildToc(UP, cfg({ header: { Interface: "16001", OptionalDeps: "inherit" } }), SHA), /OptionalDeps/);
  assert.throws(() => buildToc("A.lua [AllowLoadTextLocale deDE]\n", plain, SHA), /allowloadtextlocale/);
  assert.throws(() => buildToc("A.lua [AllowLoadGameType nonsense]\n", plain, SHA), /ambiguous/);
  assert.throws(() => buildToc("A.lua [Bogus x]\n", plain, SHA), /unknown bracket/);
  assert.doesNotThrow(() => buildToc("A.lua [AllowLoadGameType camelot]\n", plain, SHA));
});

test("validateConfig: reasons, duplicates, forbidden header keys", () => {
  assert.doesNotThrow(() => validateConfig(cfg()));
  assert.throws(() => validateConfig(cfg({ drop: [{ path: "a.lua", reason: " " }] })), /reason/);
  assert.throws(() => validateConfig(cfg({ drop: [{ path: "a.lua", reason: "r" }, { path: "A.LUA", reason: "r" }] })), /twice/);
  assert.throws(() => validateConfig(cfg({ header: { Interface: "1", "X-Wago-ID": "y" } })), /X-/);
  assert.throws(() => validateConfig(cfg({ header: { Interface: "1", "Interface-TBC": "2" } })), /per-flavour/);
  assert.throws(() => validateConfig(cfg({ header: { Title: "x" } })), /Interface/);
  assert.throws(() => validateConfig(cfg({ output: "Other.toc" })), /<addon>\.toc/);
});

test("pathKey and sameText", () => {
  assert.equal(pathKey("Libs\\Embeds.XML"), pathKey("libs/embeds.xml"));
  assert.ok(sameText("a\r\nb\r\n", "a\nb\n"));
  assert.ok(!sameText("a\nb\n", "a\nc\n"));
});

test("shippedFiles: loaded files, extras, asset folders, library licences", () => {
  const files: Record<string, string> = {
    "Way.toc": "libs\\embeds.xml\nCore.lua\n",
    "libs/embeds.xml": `<Ui><Script file="Lib\\Lib.lua"/></Ui>`,
    "libs/Lib/Lib.lua": "",
    "libs/Lib/LICENSE.txt": "",
    "libs/Unused/LICENSE": "",
    "libs/Unused/Unused.lua": "",
    "Core.lua": "",
    "Bindings.xml": "",
    "Textures/a.blp": "",
    "Textures/sub/b.tga": "",
    "Up.toc": "",
    "Scripts/x.py": "",
  };
  const index = new FileIndex(Object.keys(files));
  const c = cfg({ ship: { extraFiles: ["Bindings.xml", "LICENSE"], assetDirs: ["Textures"] } });
  const r = shippedFilesWith(files, index, c);
  assert.deepEqual(r.files, ["Bindings.xml", "Core.lua", "Textures/a.blp", "Textures/sub/b.tga", "Way.toc", "libs/Lib/LICENSE.txt", "libs/Lib/Lib.lua", "libs/embeds.xml"]);
  assert.deepEqual(r.problems, ["extra file LICENSE not found"]);
});

// shippedFiles reads files from disk; give it a fixture through a temporary directory.
function shippedFilesWith(files: Record<string, string>, index: FileIndex, c: TocConfig) {
  const dir = mkdtempSync(join(tmpdir(), "build-toc-"));
  try {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
    return shippedFiles(dir, c, index);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("buildToc: headerAppend adds our names after the inherited or literal value", () => {
  const r = buildToc(
    UP,
    cfg({
      header: { Interface: "16001", SavedVariables: "inherit", SavedVariablesPerCharacter: "OurOnly" },
      headerAppend: { SavedVariables: ["WayData"], SavedVariablesPerCharacter: ["WayChar", "WayMore"] },
    }),
    SHA,
  );
  const lines = r.text.split("\n");
  assert.equal(lines[2], "## SavedVariables: UpDB, UpSettings, WayData");
  assert.equal(lines[3], "## SavedVariablesPerCharacter: OurOnly, WayChar, WayMore");
  // A name already present upstream is an error, not a silent duplicate.
  assert.throws(
    () => buildToc(UP, cfg({ headerAppend: { SavedVariables: ["updb"] } }), SHA),
    /repeats updb/,
  );
});

test("validateConfig: headerAppend must name header keys and plain names", () => {
  assert.throws(() => validateConfig(cfg({ headerAppend: { Notes: ["X"] } })), /not a key of "header"/);
  assert.throws(() => validateConfig(cfg({ headerAppend: { SavedVariables: [] } })), /non-empty array/);
  assert.throws(() => validateConfig(cfg({ headerAppend: { SavedVariables: ["a b"] } })), /not a plain name/);
  assert.throws(() => validateConfig(cfg({ headerAppend: { SavedVariables: ["A", "A"] } })), /twice/);
  validateConfig(cfg({ headerAppend: { SavedVariables: ["WayfinderData"] } }));
});
