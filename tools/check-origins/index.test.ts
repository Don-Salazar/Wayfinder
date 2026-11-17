import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify, isBinary, scanText, validateConfig, type OriginsConfig } from "./index.ts";

const config: OriginsConfig = JSON.parse(readFileSync(new URL("./origins.json", import.meta.url), "utf8"));

test("the checked-in origins.json is valid", () => {
  assert.doesNotThrow(() => validateConfig(config));
  assert.equal(config.upstreamCommit, "22e6ce26e2855ec730d50d40f8a7d5cd733a7327");
});

test("validateConfig rejects an allowlist entry without a reason", () => {
  const bad = structuredClone(config);
  bad.markerScan.allow.push({ path: "x.lua", reason: " " });
  assert.throws(() => validateConfig(bad), /written reason/);
});

test("classify: upstream path, ours glob, unknown", () => {
  const out = classify(
    [
      { path: "RXPGuides.lua", tracked: true },
      { path: "Modules/Macros.lua", tracked: true },
      { path: "Guides/wf/Horde-01-12.lua", tracked: false },
      { path: "Guides/other/x.lua", tracked: true },
      { path: "docs/research/csv/facts.csv", tracked: false },
    ],
    new Set(["RXPGuides.lua"]),
    config.ours,
  );
  assert.deepEqual(out.map((c) => c.origin), ["upstream", "ours", "ours", "unknown", "ours"]);
});

test("scanText: case-insensitive markers with line numbers", () => {
  const text = [
    "local x = 1",
    "-- converted from questiedb tables", // marker
    "local t = npcKeys.name", // Questie data table name
    "Questie is optional runtime interop", // plain 'Questie' is allowed
    "data from a CMaNGOS dump", // cmangos + mangos
    "licensed under GPLv3",
    "GNU  General Public License",
  ].join("\n");
  const hits = scanText("f.lua", text, config.markerScan.markers);
  assert.deepEqual(
    hits.map((h) => [h.line, h.marker]),
    [
      [2, "QuestieDB"],
      [3, "Questie data tables"],
      [5, "cmangos"],
      [5, "mangos"],
      [6, "GPL-3"],
      [7, "GNU General Public License"],
    ],
  );
});

test("isBinary", () => {
  assert.ok(isBinary(new Uint8Array([80, 75, 3, 4, 0, 1])));
  assert.ok(!isBinary(new TextEncoder().encode("plain text")));
});
