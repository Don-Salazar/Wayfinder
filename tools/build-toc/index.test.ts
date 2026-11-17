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
