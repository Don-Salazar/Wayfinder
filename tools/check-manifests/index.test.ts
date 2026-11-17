import { test } from "node:test";
import assert from "node:assert/strict";
import { compareToBaseline, findingKey } from "./index.ts";
import { addonNames, FileIndex, lineApplies, loadOrder, parseFileRef, parseToc, selectToc, substituteVariables } from "./manifest.ts";

test("parseToc: metadata, comments, directives", () => {
  const toc = parseToc(
    [
      "## Interface: 16001",
      "## Title: Test",
      "#lang/off.xml [AllowLoadGameType camelot]",
      "",
      "libs\\embeds_Mainline.xml [AllowLoadGameType standard,camelot]",
      "  Core.lua  ",
      "Talents.lua [AllowLoadGameType cata,vanilla,camelot,tbc]",
    ].join("\r\n"),
  );
  assert.equal(toc.metadata.get("Interface"), "16001");
  assert.deepEqual(toc.files.map((f) => [f.line, f.path]), [
    [5, "libs\\embeds_Mainline.xml"],
    [6, "Core.lua"],
    [7, "Talents.lua"],
  ]);
  assert.deepEqual(toc.files[0]!.directives, [{ name: "allowloadgametype", value: "standard,camelot" }]);
});

test("lineApplies: allow/exclude, aliases, unknown values", () => {
  const d = (s: string) => parseFileRef(s).directives;
  assert.ok(lineApplies(d("x.lua [AllowLoadGameType standard,camelot]"), "camelot"));
  assert.ok(!lineApplies(d("x.lua [AllowLoadGameType standard,camelot]"), "vanilla"));
  assert.ok(lineApplies(d("x.lua [AllowLoadGameType Forever]"), "camelot"));
  assert.ok(lineApplies(d("x.lua [AllowLoadGameType nonsense]"), "vanilla")); // wiki: unknown values pass
  assert.ok(!lineApplies(d("x.lua [ExcludeLoadGameType camelot]"), "camelot"));
  assert.ok(lineApplies(d("x.lua"), "mists"));
});

test("variables and unknown bracket tokens", () => {
  const r = parseFileRef("Locale\\[TextLocale].lua [Bogus x]");
  assert.equal(r.path, "Locale\\[TextLocale].lua [Bogus x]");
  assert.deepEqual(r.unknown, ["[Bogus x]"]);
  assert.equal(substituteVariables("db_[Family]\\[Game].xml", "camelot"), "db_Mainline\\Camelot.xml");
});

test("selectToc: game suffix, then family, then base", () => {
  const idx = new FileIndex(["Addon.toc", "Addon_Vanilla.toc", "Addon_Classic.toc", "Addon_Mainline.toc"]);
  assert.deepEqual(addonNames(idx), ["Addon"]);
  assert.equal(selectToc(idx, "Addon", "vanilla"), "Addon_Vanilla.toc");
  assert.equal(selectToc(idx, "Addon", "tbc"), "Addon_Classic.toc");
  assert.equal(selectToc(idx, "Addon", "camelot"), "Addon_Mainline.toc");
  const forever = new FileIndex(["Addon_Forever.toc"]);
  assert.equal(selectToc(forever, "Addon", "camelot"), "Addon_Forever.toc");
  assert.equal(selectToc(forever, "Addon", "standard"), null);
});

function fixture(files: Record<string, string>) {
  const index = new FileIndex(Object.keys(files));
  const read = (p: string) => {
    const t = files[p];
    if (t === undefined) throw new Error(`no fixture ${p}`);
    return t;
  };
  return { index, read, root: "/nonexistent" };
}

test("loadOrder: XML paths resolve against the XML folder, then the addon root", () => {
  const fx = fixture({
    "A.toc": "libs\\embeds.xml\nDB/forever.xml [AllowLoadGameType camelot]\nDB/classic.xml [AllowLoadGameType vanilla]\nCore.lua\n",
    "libs/embeds.xml": `<Ui><Script file="LibStub\\LibStub.lua"/><Include file="Ace\\Ace.xml"/></Ui>`,
    "libs/LibStub/LibStub.lua": "",
    "libs/Ace/Ace.xml": `<Ui><Script file="Ace.lua"/></Ui>`,
    "libs/Ace/Ace.lua": "",
    "DB/forever.xml": `<Ui><!-- <Script file="gone.lua"/> --><Script file="DB/forever/quest.lua"/></Ui>`,
    "DB/forever/quest.lua": "",
    "DB/classic.xml": `<Ui/>`,
    "Core.lua": "",
  });
  const r = loadOrder("camelot", { ...fx, addon: "A" });
  assert.equal(r.toc, "A.toc");
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.files.map((f) => [f.path, f.via]), [
    ["A.toc", "toc"],
    ["libs/embeds.xml", "toc"],
    ["libs/LibStub/LibStub.lua", "xml-dir"],
    ["libs/Ace/Ace.xml", "xml-dir"],
    ["libs/Ace/Ace.lua", "xml-dir"],
    ["DB/forever.xml", "toc"],
    ["DB/forever/quest.lua", "addon-root"],
    ["Core.lua", "toc"],
  ]);
});

test("loadOrder: missing files and case mismatches are findings per game type", () => {
  const fx = fixture({
    "A.toc": "Guides/List-Mainline.xml [AllowLoadGameType standard]\nmissing.lua\n",
    "Guides/List-mainline.xml": `<Ui><Script file="Guides/x.Lua"/><Script file="nope.lua"/></Ui>`,
    "Guides/x.lua": "",
  });
  const std = loadOrder("standard", { ...fx, addon: "A" });
  assert.deepEqual(
    std.findings.map((f) => [f.kind, f.from, f.ref]),
    [
      ["case", "A.toc", "Guides/List-Mainline.xml"],
      ["case", "Guides/List-mainline.xml", "Guides/x.Lua"],
      ["missing", "Guides/List-mainline.xml", "nope.lua"],
      ["missing", "A.toc", "missing.lua"],
    ],
  );
  const cam = loadOrder("camelot", { ...fx, addon: "A" });
  assert.deepEqual(cam.findings.map((f) => f.kind), ["missing"]);
});

test("loadOrder: malformed XML is reported, not thrown", () => {
  const fx = fixture({ "A.toc": "bad.xml\n", "bad.xml": "<Ui><Script></Ui>" });
  const r = loadOrder("camelot", { ...fx, addon: "A" });
  assert.equal(r.findings[0]!.kind, "xml-error");
});

test("baseline comparison ignores line numbers", () => {
  const f = { gameType: "camelot" as const, kind: "case" as const, from: "UI/includes.xml", line: 2, ref: "V2\\Manifest.xml", detail: "" };
  const base = [{ gameType: "camelot" as const, kind: "case" as const, from: "UI/includes.xml", ref: "V2\\Manifest.xml" }];
  assert.deepEqual(compareToBaseline([{ ...f, line: 9 }], base), { fresh: [], stale: [] });
  const other = { ...f, ref: "new.xml" };
  const res = compareToBaseline([other], base);
  assert.deepEqual(res.fresh.map(findingKey), [findingKey(other)]);
  assert.equal(res.stale.length, 1);
});

test("baseline key separates addons; entries without addon mean RXPGuides", () => {
  const f = { gameType: "camelot" as const, kind: "case" as const, from: "UI/includes.xml", line: 2, ref: "V2\\Manifest.xml", detail: "" };
  const upstreamOnly = [{ gameType: "camelot" as const, kind: "case" as const, from: "UI/includes.xml", ref: "V2\\Manifest.xml" }];
  assert.deepEqual(compareToBaseline([{ ...f, addon: "RXPGuides" }], upstreamOnly), { fresh: [], stale: [] });
  const res = compareToBaseline([{ ...f, addon: "Wayfinder" }], upstreamOnly);
  assert.equal(res.fresh.length, 1);
  assert.equal(res.stale.length, 1);
});

test("loadOrder: untagged TOC lines load for every game type; a file loaded twice is a finding", () => {
  const fx = fixture({
    "W.toc": "## Interface: 16001\nlibs\\embeds.xml\nCore.lua\ncore.lua\n",
    "libs/embeds.xml": `<Ui><Script file="..\\Core.lua"/><Script file="Lib.lua"/></Ui>`,
    "libs/Lib.lua": "",
    "Core.lua": "",
  });
  const r = loadOrder("camelot", { ...fx, addon: "W" });
  assert.deepEqual(r.files.map((f) => f.path), ["W.toc", "libs/embeds.xml", "Core.lua", "libs/Lib.lua"]);
  assert.deepEqual(r.findings.map((f) => [f.addon, f.kind, f.from, f.ref]), [
    ["W", "duplicate", "W.toc", "Core.lua"],
    ["W", "case", "W.toc", "core.lua"],
    ["W", "duplicate", "W.toc", "core.lua"],
  ]);
});
