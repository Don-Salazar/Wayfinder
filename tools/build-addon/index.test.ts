import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lexLua } from "../inventory-ids/lex.ts";
import { checkManifests } from "./index.ts";
import { callContext, lineCount, Rebrander, validateRebrand, type RebrandConfig } from "./rebrand.ts";
import { scanResidue, validateResidue, type ResidueConfig } from "./residue.ts";

const load = <T>(name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8")) as T;
const CONFIG = load<RebrandConfig>("./rebrand.json");
const RESIDUE = load<ResidueConfig>("./residue-allow.json");
const rb = () => new Rebrander(CONFIG);

test("rebrand.json and residue-allow.json validate", () => {
  validateRebrand(CONFIG);
  validateResidue(RESIDUE);
});

test("identifiers: saved variables, globals, prefixes, infix", () => {
  const r = rb();
  const cases: [string, string][] = [
    ["RXPData", "WFData"],
    ["RXPCSettings", "WFCSettings"],
    ["RXPGuides", "WayfinderGuides"],
    ["RXP", "WayfinderAddon"],
    ["RXPOnInitialize", "WayfinderOnInitialize"],
    ["RXPV2GuideWindow", "WFV2GuideWindow"],
    ["RXPG_MenuFrame", "WFG_MenuFrame"],
    ["RXP_STEP_ACTIVATED", "WF_STEP_ACTIVATED"],
    ["RESTEDXP_BUG_REPORT_WINDOW", "WAYFINDER_BUG_REPORT_WINDOW"],
    ["RXPGuidesV2_", "WayfinderV2_"],
    ["RXPFrame", "WFFrame"],
    ["RXPTELEPORTTO", "WFTELEPORTTO"],
    ["rxpShadow", "wfShadow"],
    ["BINDING_HEADER_RXPTargeting", "BINDING_HEADER_WFTargeting"],
    ["$parentRXPTalents", "$parentWFTalents"],
    ["isRxp", "isWf"],
    ["RXPGComms", "WFGComms"],
    ["RXPTargeting", "WFTargeting"],
    ["GetMapID", "GetMapID"],
  ];
  for (const [a, b] of cases) assert.equal(r.renameIdent(a), b, a);
});

test("lua: code, _G strings, concatenations, format strings; comments untouched", () => {
  const src = [
    `-- RXPFrame comment stays`,
    `local f = CreateFrame("Frame", "RXPItemFrame", UIParent)`,
    `local n = "RXPActiveStepsFrame" .. name`,
    `local s = CreateFrame("Slider", ("RXPV2ScrollFrame%dScrollBar"):format(num))`,
    `_G["BINDING_NAME_" .. format("CLICK RXPItemFrameButton%d:LeftButton", i)] = 1`,
    `self.db = LibStub("AceDB-3.0"):New("RXPSettings", RXPData.defaultProfile)`,
    `addon:SendEvent("RXP_STEP_ACTIVATED", step)`,
    `local c = addon.guideTextColors["RXP_WARN_"]`,
    `for RXP_ in string.gmatch(t, "RXP_[A-Z]+_") do end`,
    `local w = L"Set your Hearthstone to |cRXP_WARN_%s|r"`,
    `local p = "Interface\\\\Addons\\\\RXPGuides\\\\Textures\\\\x"`,
    `local q = "Interface/AddOns/rxpguides/Textures/x"`,
    `local t = "/Textures/rxp_logo-64"`,
  ].join("\n");
  const out = rb().lua(src, "X.lua").split("\n");
  assert.equal(out[0], `-- RXPFrame comment stays`);
  assert.equal(out[1], `local f = CreateFrame("Frame", "WFItemFrame", UIParent)`);
  assert.equal(out[2], `local n = "WFActiveStepsFrame" .. name`);
  assert.equal(out[3], `local s = CreateFrame("Slider", ("WFV2ScrollFrame%dScrollBar"):format(num))`);
  assert.equal(out[4], `_G["BINDING_NAME_" .. format("CLICK WFItemFrameButton%d:LeftButton", i)] = 1`);
  assert.equal(out[5], `self.db = LibStub("AceDB-3.0"):New("WFSettings", WFData.defaultProfile)`);
  assert.equal(out[6], `addon:SendEvent("WF_STEP_ACTIVATED", step)`);
  assert.equal(out[7], `local c = addon.guideTextColors["RXP_WARN_"]`, "colour keys stay (guide markup)");
  assert.equal(out[8], `for WF_ in string.gmatch(t, "RXP_[A-Z]+_") do end`, "loop variable renamed, pattern kept");
  assert.equal(out[9], `local w = L"Set your Hearthstone to |cRXP_WARN_%s|r"`,"cRXP_ markup kept");
  assert.equal(out[10], `local p = "Interface\\\\Addons\\\\Wayfinder\\\\Textures\\\\x"`);
  assert.equal(out[11], `local q = "Interface/AddOns/Wayfinder/Textures/x"`);
  assert.equal(out[12], `local t = "/Textures/rxp_logo-64"`, "asset file names stay");
});

test("lua: slash commands by call context, help text, branding, credits and group names", () => {
  const src = [
    `self:RegisterChatCommand("rxp", f)`,
    `self:RegisterChatCommand("rxpguides", f)`,
    `local h = "|cff909090/rxp splits|r and /rxpg"`,
    `f:SetTitle("RestedXP: " .. title)`,
    `local a = L("Welcome to RestedXP Guides\\nRight click to pick a guide")`,
    `L["Welcome to RestedXP Guides\\nRight click to pick a guide"] = "Willkommen bei RestedXP Guides"`,
    `local g = L"RestedXP Forever Guide (A)"`,
    `author = "RestedXP",`,
    `name = "Based on RestedXP Guides (github.com/RestedXP/RXPGuides), CC BY-NC-SA 4.0"`,
    `if group == "RXPGuides" then return end`,
    `API.RegisterJunkPlugin(addonName, "RXPGuides", fn)`,
    `local u = L("Advertises and compares addon versions with all RXP users in party")`,
  ].join("\n");
  const out = rb().lua(src, "X.lua").split("\n");
  assert.equal(out[0], `self:RegisterChatCommand("wf", f)`);
  assert.equal(out[1], `self:RegisterChatCommand("wayfinder", f)`);
  assert.equal(out[2], `local h = "|cff909090/wf splits|r and /wfg"`);
  assert.equal(out[3], `f:SetTitle("Wayfinder: " .. title)`);
  assert.equal(out[4], `local a = L("Welcome to Wayfinder\\nRight click to pick a guide")`);
  assert.equal(out[5], `L["Welcome to Wayfinder\\nRight click to pick a guide"] = "Willkommen bei Wayfinder"`, "locale key changes exactly like the lookup");
  assert.equal(out[6], `local g = L"RestedXP Forever Guide (A)"`, "guide group name kept");
  assert.equal(out[7], `author = "RestedXP",`);
  assert.equal(out[8], `name = "Based on RestedXP Guides (github.com/RestedXP/RXPGuides), CC BY-NC-SA 4.0"`);
  assert.equal(out[9], `if group == "RXPGuides" then return end`);
  assert.equal(out[10], `API.RegisterJunkPlugin(addonName, "Wayfinder", fn)`);
  assert.equal(out[11], `local u = L("Advertises and compares addon versions with all Wayfinder users in party")`);
});

test("guide files: only the two globals in code; guide text byte-identical", () => {
  const src = [
    `local _, addon = ...`,
    `if not RXP.enabledLocale then return end`,
    `RXPGuides.RegisterGuide([[`,
    `#group RestedXP Forever Dungeon Guide (H)`,
    `.goto Durotar,50,50 >>Talk to |cRXP_FRIENDLY_Gornek|r`,
    `]])`,
    `addon.talents.RegisterGuide("x")`,
    `local y = addon.RXP`,
  ].join("\n");
  const out = rb().lua(src, "Guides/forever/H-1.lua").split("\n");
  assert.equal(out[1], `if not WayfinderAddon.enabledLocale then return end`);
  assert.equal(out[2], `WayfinderGuides.RegisterGuide([[`);
  assert.deepEqual(out.slice(3, 7), src.split("\n").slice(3, 7));
  assert.equal(out[7], `local y = addon.RXP`, "field access in a guide file is not a global");
});

test("xml, Bindings.xml and TOC SavedVariables", () => {
  const r = rb();
  assert.equal(
    r.xml(`<Binding name="CLICK RXPItemFrameButton1:LeftButton" header="Active Items" category="BINDING_HEADER_RXPGuides" /><!-- RXP -->`),
    `<Binding name="CLICK WFItemFrameButton1:LeftButton" header="Active Items" category="BINDING_HEADER_WFGuides" /><!-- RXP -->`,
  );
  assert.equal(
    r.xml(`<Slider name="RXPV2ScrollBarTemplate"><Button inherits="RXPV2ScrollUpButtonTemplate"/><Tex file="Interface\\Addons\\RXPGuides\\Textures\\v2\\k"/></Slider>`),
    `<Slider name="WFV2ScrollBarTemplate"><Button inherits="WFV2ScrollUpButtonTemplate"/><Tex file="Interface\\Addons\\Wayfinder\\Textures\\v2\\k"/></Slider>`,
  );
  const toc = `# from RXPGuides.toc\r\n## Notes: Based on RestedXP Guides\r\n## SavedVariables: RXPData, RXPDB, RXPSettings\r\n## SavedVariablesPerCharacter: RXPCData, RXPCComms\r\nRXPGuides.lua\r\n`;
  assert.equal(
    r.toc(toc),
    `# from RXPGuides.toc\r\n## Notes: Based on RestedXP Guides\r\n## SavedVariables: WFData, WFDB, WFSettings\r\n## SavedVariablesPerCharacter: WFCData, WFCComms\r\nRXPGuides.lua\r\n`,
  );
});

test("line counts never change (long strings, CRLF)", () => {
  const src = `local a = [[\r\nRestedXP Guides\r\nRXPFrame\r\n]]\r\nRXPCData.x = 1 -- RXP\r\n`;
  const out = rb().lua(src, "X.lua");
  assert.equal(lineCount(out), lineCount(src));
  assert.match(out, /WFCData\.x = 1 -- RXP/);
});

test("collision check: a rename that would merge two distinct literals is reported", () => {
  const r = rb();
  r.lua(`local a, b = L"Welcome to RestedXP Guides", L"Welcome to Wayfinder"`, "X.lua");
  assert.ok(r.collisions().some((m) => m.includes("Welcome to Wayfinder")));
  const ok = rb();
  ok.lua(`local a = L"Welcome to RestedXP Guides"\nL["Welcome to RestedXP Guides"] = "x"`, "X.lua");
  assert.deepEqual(ok.collisions(), []);
});

test("callContext finds callee and argument position", () => {
  const src = `obj:RegisterJunkPlugin(addonName, "RXPGuides", function() end)`;
  const { tokens } = lexLua(src);
  const i = tokens.findIndex((t) => t.type === "string");
  assert.deepEqual(callContext(tokens, i), { name: "RegisterJunkPlugin", arg: 2 });
  const t2 = lexLua(`local x = "RXPGuides"`).tokens;
  assert.equal(callContext(t2, t2.length - 1), undefined);
});

test("residue: classes and unclassified hits", () => {
  const lua = [
    `-- RestedXP comment`,
    `local a = "|cRXP_WARN_x|r"`,
    `local g = "RestedXP Forever Guide (A)"`,
    `local t = "rxp-borders"`,
    `local bad = "RXPLeftover"`,
  ].join("\n");
  const hits = scanResidue("Engine.lua", lua, RESIDUE);
  assert.deepEqual(
    hits.map((h) => [h.line, h.cls]),
    [[1, "comments"], [2, "guide-markup"], [3, "group-names"], [4, "asset-names"], [5, undefined]],
  );
  const guide = scanResidue("Guides/forever/x.lua", `RXPGuides.RegisterGuide([[\n#group RestedXP\n]])`, RESIDUE);
  assert.deepEqual(guide.map((h) => h.cls), [undefined, "guide-text"], "a code-token RXPGuides left in a guide file is residue");
  assert.equal(scanResidue("libs/AceGUI/x.lua", `local RXP = 1`, RESIDUE)[0]!.cls, "libs");
});

test("xml file references: only the addon-folder path rule applies (manifest entries keep their file names)", () => {
  const r = rb();
  assert.equal(
    r.xml(`<Ui><Script file="Guides/forever/RestedXP-Skyborne.lua"/><Include file="forever\dungeon\RestedXP-Skyborne.lua"/><Script file="RXPGuides.lua"/></Ui>`),
    `<Ui><Script file="Guides/forever/RestedXP-Skyborne.lua"/><Include file="forever\dungeon\RestedXP-Skyborne.lua"/><Script file="RXPGuides.lua"/></Ui>`,
  );
  assert.equal(r.xml(`<Tex file="Interface\\Addons\\RXPGuides\\Textures\\k"/>`), `<Tex file="Interface\\Addons\\Wayfinder\\Textures\\k"/>`);
  assert.equal(r.toc(`## Title: x\nGuides/forever/RestedXP-Skyborne.lua\nRXPGuides.lua\n`), `## Title: x\nGuides/forever/RestedXP-Skyborne.lua\nRXPGuides.lua\n`);
});

test("residue: an RXP+uppercase name in engine code fails even where a class would allow it", () => {
  const lua = [
    `local t = f:CreateTexture("RXPLevelSplitsFrameBG", "BACKGROUND")`,
    `--[[ f:CreateTexture("RXPLevelSplitsFrameBG") ]]`,
    `local k = gtc["RXP_WARN_"]`,
    `local g = "RXPGuides"`,
    `local h = "RXP_FOO_"`,
    `local s = "RXP Speedrun Guide"`,
    `local a = RXPLeftoverGlobal`,
    `local u = "github.com/RestedXP/RXPGuides"`,
  ].join("\n");
  const hits = scanResidue("LevelingTracker.lua", lua, RESIDUE);
  assert.deepEqual(
    hits.map((h) => [h.line, h.forbidden ?? h.cls ?? "-"]),
    [[1, "rxp-name-in-engine"], [2, "comments"], [3, "guide-markup"], [4, "group-names"], [5, "rxp-name-in-engine"], [6, "group-names"], [7, "rxp-name-in-engine"], [8, "credits"], [8, "credits"]],
  );
  assert.equal(scanResidue("Guides/forever/x.lua", `x = [[RXPFrame]]`, RESIDUE)[0]!.forbidden, undefined, "guide text is exempt");
});

test("checkManifests: every TOC/XML reference in the built addon must resolve inside it", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-dist-"));
  const d = join(root, "dist", "Wayfinder");
  mkdirSync(join(d, "Guides", "forever"), { recursive: true });
  writeFileSync(join(d, "Wayfinder.toc"), "## Interface: 16001\nCore.lua\nGuides/GuideList.xml\n");
  writeFileSync(join(d, "Core.lua"), "\n");
  writeFileSync(join(d, "Guides", "forever", "RestedXP-Skyborne.lua"), "\n");
  writeFileSync(join(d, "Guides", "GuideList.xml"), `<Ui>\n<Script file="forever/RestedXP-Skyborne.lua"/>\n</Ui>\n`);
  try {
    assert.deepEqual(checkManifests(root, "dist/Wayfinder").problems, []);
    writeFileSync(join(d, "Guides", "GuideList.xml"), `<Ui>\n<Script file="forever/Wayfinder-Skyborne.lua"/>\n</Ui>\n`);
    const p = checkManifests(root, "dist/Wayfinder").problems;
    assert.ok(p.some((m) => m.includes("Wayfinder-Skyborne.lua")), p.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
