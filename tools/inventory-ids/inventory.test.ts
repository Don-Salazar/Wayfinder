import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMENT, CODE, lexLua, STRING } from "./lex.ts";
import { CATEGORIES, RULES } from "./rules.ts";
import { buildInventory, renderMarkdown } from "./report.ts";
import { addAssetNames, analyzeLua, callArg, prepare, scanFile, type Hit, type Lang, type SourceFile, type Status } from "./scan.ts";

function file(path: string, src: string, status: Status = "forever", lang?: Lang): SourceFile {
  const l = lang ?? (path.endsWith(".toc") ? "toc" : path.endsWith(".xml") ? "xml" : "lua");
  const isGuide = l === "lua" && (/^(guides|lang\/guides-[^/]+)\//i.test(path) || /(?<![.\w])RXPGuides\s*\.\s*RegisterGuide\s*\(/.test(src));
  return { path, lang: l, src, status, loadedOn: status === "forever" ? ["camelot"] : [], isGuide };
}

const TOC = file("RXPGuides.toc", "## Title: RestedXP Guides\n## SavedVariables: RXPData, RXPDB\n## SavedVariablesPerCharacter: RXPCData\n## OptionalDeps: Questie, RXPGuides_Themes\n## X-Wago-ID: ZKbebq61\n# comment RXP\nRXPGuides.lua\n");

/** Scan fixtures together (prepare sees all of them) and return hits of the named file. */
function scan(target: SourceFile, others: SourceFile[] = []): Hit[] {
  const all = [TOC, target, ...others];
  const tree = prepare(all);
  addAssetNames(tree, all.map((f) => f.path));
  return scanFile(target, tree, RULES).hits;
}

const find = (hits: Hit[], category: string, id: string) => hits.filter((h) => h.category === category && h.id === id);

describe("lexLua", () => {
  it("marks strings, long strings and comments", () => {
    const src = `local a = "RXP" -- RXP\nlocal b = [==[ RXP ]==] --[[ RXP ]] c = 'x'`;
    const { region, tokens } = lexLua(src);
    assert.equal(region[src.indexOf('"RXP"') + 1], STRING);
    assert.equal(region[src.indexOf("-- RXP") + 3], COMMENT);
    assert.equal(region[src.indexOf("[==[") + 5], STRING);
    assert.equal(region[src.indexOf("--[[") + 5], COMMENT);
    assert.equal(region[src.indexOf("c =")], CODE);
    assert.deepEqual(tokens.filter((t) => t.type === "name").map((t) => t.value), ["local", "a", "local", "b", "c"]);
  });
  it("handles escaped quotes", () => {
    const src = `x = "a\\"RXP" y = 1`;
    const { region } = lexLua(src);
    assert.equal(region[src.indexOf("y")], CODE);
    assert.equal(region[src.indexOf("RXP")], STRING);
  });
});

describe("analyzeLua", () => {
  it("separates locals, global assignments, global functions and table keys", () => {
    const a = analyzeLua(
      [
        "local L, M = 1, 2",
        "local function lf() end",
        "Foo = 1",
        "L = 3",
        "t = { key = 1, nested = { deep = 2 } }",
        "function Bar(p) p = 1 end",
        "function Baz.qux() end",
        "_G.Qux = 1",
        '_G["Quux"] = 2',
        "_G.StaticPopupDialogs[k] = {}",
        "for i, v in pairs(x) do i = 1 end",
        "a.b.c = 1",
        "function obj:method() self.x = 1 end",
      ].join("\n"),
    );
    const ids = a.writes.map((w) => `${w.kind}:${w.id}`).sort();
    assert.deepEqual(ids, ["_G:Quux", "_G:Qux", "assign:Foo", "assign:t", "field:Baz.qux", "field:StaticPopupDialogs[k]", "field:a.b", "field:obj:method", "function:Bar"].sort());
    for (const n of ["L", "M", "lf", "p", "i", "v", "self"]) assert.ok(a.locals.has(n), n);
  });
});

describe("callArg", () => {
  it("returns the nth argument, skipping nested calls and strings", () => {
    const src = `f("a,b", g(1, 2), {x, y}, "z")`;
    const { region } = lexLua(src);
    const p = src.indexOf("(");
    assert.equal(callArg(src, region, p, 0)?.text, `"a,b"`);
    assert.equal(callArg(src, region, p, 1)?.text, "g(1, 2)");
    assert.equal(callArg(src, region, p, 2)?.text, "{x, y}");
    assert.equal(callArg(src, region, p, 3)?.text, `"z"`);
    assert.equal(callArg(src, region, p, 4), null);
  });
});

describe("classifiers", () => {
  it("TOC metadata: one finding per saved variable / dependency; comment lines are comments", () => {
    const hits = scan(TOC);
    assert.equal(find(hits, "toc", "RXPData").length, 1);
    assert.equal(find(hits, "toc", "RXPCData")[0]?.detail, "## SavedVariablesPerCharacter");
    assert.equal(find(hits, "toc", "RestedXP Guides").length, 1);
    assert.equal(find(hits, "toc", "ZKbebq61").length, 1);
    assert.equal(find(hits, "toc", "RXPGuides.toc")[0]?.line, 0);
    assert.equal(find(hits, "files", "RXPGuides.lua").length, 1);
    assert.equal(hits.filter((h) => h.category === "comments").length, 1);
    assert.equal(hits.filter((h) => h.category === "unclassified").length, 0);
  });

  it("saved variables from the TOC, incl. AceDB names, _G access, not same-named fields", () => {
    const hits = scan(
      file(
        "a.lua",
        [
          "local _, addon = ...",
          'local db = LibStub("AceDB-3.0"):New("RXPDB", defaults)',
          "RXPData = RXPData or {}",
          "local x = _G.RXPCData",
          "local y = addon.RXPData",
        ].join("\n"),
      ),
    );
    assert.equal(find(hits, "savedvars", "RXPDB")[0]?.detail, "AceDB:New");
    assert.deepEqual(find(hits, "savedvars", "RXPData").map((h) => h.detail), ["write", "read"]);
    assert.equal(find(hits, "savedvars", "RXPCData").length, 1);
    // addon.RXPData is a field, not the saved variable
    assert.equal(find(hits, "internal", "RXPData").length, 1);
  });

  it("globals: writes, reads in other files, _G exports, undeclared RXP names", () => {
    const def = file("def.lua", "local addonName, addon = ...\nlocal T = {}\n_G.RXPGuides = T\nRXP = addon\nfunction LeakyHelper() end\n");
    const use = file("use.lua", "local x = RXP.foo\nLeakyHelper()\nRXPUndeclared.y = 1\nlocal RXPLocal = 1\n");
    const hDef = scan(def, [use]);
    assert.ok(find(hDef, "globals", "RXPGuides").length === 1);
    assert.ok(find(hDef, "globals", "RXP").some((h) => h.detail === "write: global assign"));
    assert.ok(find(hDef, "globals", "LeakyHelper").some((h) => h.detail === "write: global function"));
    const hUse = scan(use, [def]);
    assert.ok(find(hUse, "globals", "RXP")[0]?.detail?.startsWith("read"));
    assert.ok(find(hUse, "globals", "LeakyHelper")[0]?.detail?.startsWith("read"));
    assert.ok(find(hUse, "globals", "RXPUndeclared.y").length === 1);
    assert.equal(find(hUse, "internal", "RXPLocal")[0]?.detail, "local/parameter");
  });

  it("guide coupling: global entry points and private-table calls in guide files", () => {
    const g = file("Guides/forever/x.lua", 'local L = GetLocale() if RXP.enabledLocale[L] then return end\nRXPGuides.RegisterGuide([[\n#group RestedXP Forever Guide (H)\n#groupid RXP-SRGCE-H1\nstep\n  .goto Durotar,1,2 >> Talk to |cRXP_FRIENDLY_Gornek|r\n]])\n');
    const engine = file("RXPGuides.lua", "local addonName, addon = ...\nlocal RXPGuides = {}\n_G.RXPGuides = RXPGuides\nRXP = addon\n");
    const hits = scan(g, [engine]);
    assert.equal(find(hits, "guide-coupling", "RXPGuides.RegisterGuide").length, 1);
    assert.equal(find(hits, "guide-coupling", "RXP.enabledLocale").length, 1);
    assert.equal(find(hits, "branding", "RestedXP Forever Guide (H)").length, 1);
    assert.equal(find(hits, "guide-markup", "RXP-SRGCE-H1").length, 1);
    assert.equal(find(hits, "guide-markup", "cRXP_FRIENDLY_").length, 1);
    const t = file("Guides/Talents/x.lua", "local _, addon = ...\naddon.talents.RegisterGuide([[ ]])\n");
    assert.equal(find(scan(t), "guide-coupling", "addon.talents.RegisterGuide").length, 1);
  });

  it("frames: literal, $parent, computed names, named textures, templates", () => {
    const hits = scan(
      file(
        "f.lua",
        [
          'local f = CreateFrame("Frame", "RXPFrame", UIParent, "RXPV2ScrollBarTemplate")',
          'local g = CreateFrame("Button", "$parentCheck", f)',
          'local h = CreateFrame("Button", "RXPTargetFrame_Button" .. i, f)',
          'local n = CreateFrame("Frame", nil, f)',
          'f.icon = f:CreateTexture("RXPIcon", "ARTWORK")',
        ].join("\n"),
      ),
    );
    assert.equal(find(hits, "frames", "RXPFrame")[0]?.detail, "CreateFrame literal name");
    assert.equal(find(hits, "frames", "$parentCheck")[0]?.detail, "CreateFrame $parent-relative name");
    assert.equal(find(hits, "frames", '"RXPTargetFrame_Button" .. i')[0]?.detail, "CreateFrame computed name (expression)");
    assert.equal(find(hits, "frames", "RXPV2ScrollBarTemplate").length, 1);
    assert.equal(find(hits, "frames", "RXPIcon").length, 1);
    assert.equal(hits.filter((h) => h.category === "frames").length, 5);
  });

  it("XML: bindings, frame names, inherits, hard-coded addon paths", () => {
    const bind = file("Bindings.xml", '<Bindings>\n<Binding name="CLICK RXPItemFrameButton1:LeftButton" header="Active Items" category="BINDING_HEADER_RXPGuides"/>\n</Bindings>');
    const hb = scan(bind);
    assert.equal(find(hb, "bindings", "CLICK RXPItemFrameButton1:LeftButton").length, 1);
    assert.equal(find(hb, "bindings", "BINDING_HEADER_RXPGuides").length, 1);
    const ui = file(
      "UI/t.xml",
      '<Ui>\n<!-- RXP comment -->\n<Button name="RXPV2UpTemplate" virtual="true">\n<NormalTexture file="Interface\\Addons\\RXPGuides\\Textures\\v2\\up"/>\n</Button>\n<Slider name="$parentBar" inherits="RXPV2UpTemplate"/>\n</Ui>',
    );
    const hu = scan(ui);
    assert.equal(find(hu, "frames", "RXPV2UpTemplate").length, 2); // definition + inherits
    assert.equal(find(hu, "addon-folder", "Interface/Addons/RXPGuides/Textures/v2/").length, 1);
    assert.equal(hu.filter((h) => h.category === "comments").length, 1);
  });

  it("slash commands, comms prefixes, Ace registrations, messages, popups, macros", () => {
    const hits = scan(
      file(
        "s.lua",
        [
          'SLASH_RXPTEST1 = "/rxptest"',
          'SlashCmdList["RXPTEST"] = function() end',
          'self:RegisterChatCommand("rxp", self.ChatCommand)',
          'addon.comms._commPrefix = "RXPGComms"',
          "self:RegisterComm(self._commPrefix)",
          'addon = LibStub("AceAddon-3.0"):NewAddon(addon, addonName, "AceEvent-3.0")',
          'addon.comms = addon:NewModule("Communications")',
          'local L = LibStub("AceLocale-3.0"):NewLocale(addonName, "enUS", true)',
          "LibDBIcon:Register(addonName, button, db)",
          'local Type, Version = "RXPV2Popup", 1',
          'addon:SendEvent("RXP_STEP_ACTIVATED", step)',
          '_G.StaticPopupDialogs["RXP_Link"] = {}',
          'addon.targeting.macroName = "RXPTargeting"',
        ].join("\n"),
      ),
    );
    assert.equal(find(hits, "slash", "SLASH_RXPTEST1").length, 1);
    assert.equal(find(hits, "slash", "/rxptest").length, 1);
    assert.equal(find(hits, "slash", "RXPTEST").length, 1);
    assert.equal(find(hits, "slash", "/rxp").length, 1);
    assert.equal(find(hits, "comms", "RXPGComms").length, 1);
    assert.equal(find(hits, "comms", "self._commPrefix")[0]?.detail, "RegisterComm");
    assert.equal(find(hits, "ace", "addonName").length, 3); // NewAddon, NewLocale, LibDBIcon:Register
    assert.equal(find(hits, "ace", "Communications").length, 1);
    assert.equal(find(hits, "ace", "RXPV2Popup").length, 1);
    assert.equal(find(hits, "registries", "RXP_STEP_ACTIVATED").length, 1);
    assert.equal(find(hits, "registries", "RXP_Link").length, 1);
    assert.equal(find(hits, "registries", "RXPTargeting").length, 1);
    assert.equal(hits.filter((h) => h.category === "unclassified").length, 0);
  });

  it("branding strings, URLs, commercial words, asset names, comments; catch-all for leftovers", () => {
    const hits = scan(
      file(
        "b.lua",
        [
          'print("Welcome to RestedXP Guides")',
          'local url = "https://discord.gg/RestedXP"',
          'local s = "Buy the premium guides"',
          'icon = "Interface/AddOns/" .. addonName .. "/Textures/rxp_logo-64"',
          "-- RXP note",
          'local key = "RXP_SOMETHING_ODD"',
        ].join("\n"),
      ),
      [file("Textures/rxp_logo-64.blp", "", "other")],
    );
    assert.equal(find(hits, "files", "rxp_logo-64").length, 1);
    assert.equal(find(hits, "branding", "Welcome to RestedXP Guides").length, 1);
    assert.equal(find(hits, "urls", "discord.gg").length, 1);
    assert.equal(find(hits, "urls", "premium").length, 1);
    assert.equal(find(hits, "urls", "buy").length, 1);
    assert.equal(find(hits, "addon-folder", 'Interface/AddOns/" .. addonName').length, 1);
    assert.equal(find(hits, "comments", "RXP").length, 1);
    const left = hits.filter((h) => h.category === "unclassified");
    assert.deepEqual(left.map((h) => h.id), ["RXP_SOMETHING_ODD"]);
  });

  it("asset names only match real files", () => {
    // prepare() sees only scanned sources; asset names come from the full tracked list
    const f = file("c.lua", 'local a = "rxp_logo-64"\nlocal b = "rxp_not_a_file"\n');
    const tree = prepare([TOC, f]);
    tree.assetNames.add("rxp_logo-64");
    const hits = scanFile(f, tree, RULES).hits;
    assert.equal(find(hits, "files", "rxp_logo-64").length, 1);
    assert.equal(find(hits, "files", "rxp_not_a_file").length, 0);
  });
});

describe("coverage and output", () => {
  it("every raw RXP occurrence is owned by exactly one finding", () => {
    const f = file("x.lua", 'RXPFrame = CreateFrame("Frame", "RXPFrame") -- RXP\nlocal s = "RestedXP RXP rxp"\n');
    const tree = prepare([TOC, f]);
    const r = scanFile(f, tree, RULES);
    const raw = [...f.src.matchAll(/restedxp|rxp/gi)].length;
    assert.equal(r.rawTotal, raw);
    assert.equal(r.hits.reduce((s, h) => s + h.raw, 0), raw);
  });

  it("is deterministic and renders every category", () => {
    const files = [TOC, file("a.lua", 'local f = CreateFrame("Frame", "RXPFrame")\nprint("RestedXP")\n'), file("lib/x.lua", "RXP = 1", "library")];
    const run = () => {
      const tree = prepare(files);
      const per = new Map(files.map((f) => [f.path, scanFile(f, tree, RULES)]));
      return buildInventory(files, per, tree, { upstreamCommit: "abc", date: "2026-11-16" });
    };
    const a = run();
    const b = run();
    assert.deepEqual(a, b);
    assert.equal(a.categories.length, CATEGORIES.length);
    assert.equal(a.totals.rawUnclassified, 0);
    const md = renderMarkdown(a);
    for (const c of CATEGORIES) assert.ok(md.includes(`| ${c.num} | ${c.title} |`), c.title);
    assert.ok(md.includes("`abc`") && md.includes("2026-11-16"));
  });

  it("rule ids are unique and categories exist", () => {
    const ids = RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    const cats = new Set(CATEGORIES.map((c) => c.id));
    for (const r of RULES) assert.ok(cats.has(r.category), r.id);
  });
});
