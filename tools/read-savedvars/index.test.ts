import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, pickLatest } from "./index.ts";
import { ParseError, parseSavedVariables, toJsonText } from "./parse.ts";

// Shaped like the client's SavedVariables writer output (synthetic values).
const FIXTURE = [
  "",
  "WayfinderData = {",
  '\t["toggles"] = {',
  '\t\t["selftest"] = true,',
  '\t\t["fieldlog"] = false,',
  "\t},",
  '\t["selftest"] = {',
  '\t\t["version"] = "0.1.0-dev",',
  '\t\t["results"] = {',
  "\t\t\t{",
  '\t\t\t\t["id"] = "client.locale",',
  '\t\t\t\t["status"] = "pass",',
  '\t\t\t\t["value"] = "enUS",',
  "\t\t\t}, -- [1]",
  "\t\t\t{",
  '\t\t\t\t["id"] = "position.unit",',
  '\t\t\t\t["value"] = {',
  '\t\t\t\t\t["x"] = -1234.5,',
  '\t\t\t\t\t["y"] = 1.5e+3,',
  "\t\t\t\t},",
  "\t\t\t}, -- [2]",
  "\t\t},",
  '\t\t["empty"] = {',
  "\t\t\t{",
  "\t\t\t},",
  "\t\t},",
  "\t},",
  "}",
  "WayfinderCharData = nil",
  "",
].join("\n");

test("parses nested tables, arrays, numbers and nil", () => {
  const v = parseSavedVariables(FIXTURE) as any;
  assert.deepEqual(v.WayfinderData.toggles, { selftest: true, fieldlog: false });
  const results = v.WayfinderData.selftest.results;
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 2);
  assert.equal(results[0].status, "pass");
  assert.deepEqual(results[1].value, { x: -1234.5, y: 1500 });
  // Nested empties: {} inside an array.
  assert.deepEqual(v.WayfinderData.selftest.empty, [{}]);
  assert.equal(v.WayfinderCharData, null);
});

test("accepts Windows line endings and a BOM", () => {
  const crlf = "﻿" + FIXTURE.replace(/\n/g, "\r\n");
  assert.deepEqual(parseSavedVariables(crlf), parseSavedVariables(FIXTURE));
});

test("decodes string escapes", () => {
  const v = parseSavedVariables(String.raw`A = "say \"hi\"\n\ttab \\ back \65\066 'q'"` + "\nB = 'it\\'s'\n");
  assert.equal(v.A, 'say "hi"\n\ttab \\ back AB \'q\'');
  assert.equal(v.B, "it's");
  // Backslash-newline (Lua's escaped line break), with CRLF.
  assert.equal(parseSavedVariables('C = "a\\\r\nb"').C, "a\nb");
  assert.throws(() => parseSavedVariables('D = "bad \\q"'), ParseError);
});

test("numbers: negatives, exponents, hex, decimals", () => {
  const v = parseSavedVariables("A = { -1, 2.5, 1e3, -2E-2, 0x1F, .5, - 3 }");
  assert.deepEqual(v.A, [-1, 2.5, 1000, -0.02, 31, 0.5, -3]);
});

test("mixed positional and keyed tables become objects with numeric keys", () => {
  const v = parseSavedVariables('A = { "x", "y", ["k"] = 1 }\nB = { [1] = "a", [3] = "c" }\nC = { [2] = "b", [1] = "a" }');
  assert.deepEqual(v.A, { "1": "x", "2": "y", k: 1 });
  assert.deepEqual(v.B, { "1": "a", "3": "c" });
  assert.deepEqual(v.C, ["a", "b"]);
});

test("name keys, true/false keys, semicolons, comments and long strings", () => {
  const src = [
    "--[[ block",
    "comment ]] A = { name = 1; [true] = 2, [false] = true, nested = { }, }",
    "B = [[line1",
    "line2]] -- trailing",
    "C = { true, false, nil, 4 }",
  ].join("\n");
  const v = parseSavedVariables(src) as any;
  assert.deepEqual(v.A, { name: 1, true: 2, false: true, nested: {} });
  assert.equal(v.B, "line1\nline2");
  // A nil hole leaves keys 1, 2, 4: an object, not an array.
  assert.deepEqual(v.C, { "1": true, "2": false, "4": 4 });
});

test("reports the line and column of a syntax error", () => {
  try {
    parseSavedVariables("A = {\n  [\"k\"] = ,\n}");
    assert.fail("expected an error");
  } catch (e) {
    assert.ok(e instanceof ParseError);
    assert.equal(e.line, 2);
  }
  assert.throws(() => parseSavedVariables("A = { 1, 2"), /unfinished table|expected/);
  assert.throws(() => parseSavedVariables('A = "open'), /unfinished string/);
  assert.throws(() => parseSavedVariables("A = os.time()"), ParseError);
});

test("toJsonText writes non-finite numbers as strings", () => {
  assert.equal(toJsonText({ a: Infinity }), '{\n  "a": "Infinity"\n}');
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["f.lua", "--var", "WayfinderData", "--json", "o.json"]), {
    file: "f.lua",
    variable: "WayfinderData",
    json: "o.json",
  });
  assert.deepEqual(parseArgs(["--latest", "dir"]), { latest: "dir" });
  assert.match(parseArgs([]) as string, /give a SavedVariables file/);
  assert.match(parseArgs(["--var"]) as string, /needs a value/);
  assert.match(parseArgs(["a.lua", "b.lua"]) as string, /more than one/);
  assert.match(parseArgs(["a.lua", "--latest", "d"]) as string, /not both/);
  assert.match(parseArgs(["--bogus"]) as string, /unknown option/);
});

test("pickLatest: newest of Wayfinder.lua and .bak, also from the account folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-savedvars-"));
  try {
    assert.equal(pickLatest(dir), undefined);
    const sv = join(dir, "SavedVariables");
    const live = join(sv, "Wayfinder.lua");
    const bak = join(sv, "Wayfinder.lua.bak");
    writeFileSync(join(dir, "Other.lua"), "X = 1");
    mkdirSync(sv);
    writeFileSync(live, "A = 1");
    writeFileSync(bak, "A = 0");
    utimesSync(bak, new Date(2026, 0, 1), new Date(2026, 0, 1));
    utimesSync(live, new Date(2026, 0, 2), new Date(2026, 0, 2));
    assert.equal(pickLatest(dir), live);
    assert.equal(pickLatest(sv), live);
    utimesSync(bak, new Date(2026, 0, 3), new Date(2026, 0, 3));
    assert.equal(pickLatest(sv), bak);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

