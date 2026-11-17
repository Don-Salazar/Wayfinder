import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toCsv } from "./csv.ts";
import { globToRegExp, normalizePath } from "./files.ts";
import { childElements, parseXml, textContent } from "./xml.ts";

test("csv: quotes only when needed and round-trips", () => {
  const rows = [
    ["row", "a", "b"],
    ["2", 'say "hi"', "x,y"],
    ["3", "line1\nline2", " padded "],
    ["4", "", "plain"],
  ];
  const text = toCsv(rows);
  assert.equal(text, 'row,a,b\n2,"say ""hi""","x,y"\n3,"line1\nline2"," padded "\n4,,plain\n');
  assert.deepEqual(parseCsv(text), rows);
});

test("csv: accepts CRLF and a BOM", () => {
  assert.deepEqual(parseCsv("﻿a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

test("csv: unterminated quote is an error", () => {
  assert.throws(() => parseCsv('a,"b\n'));
});

test("xml: elements, attributes, entities, comments, CDATA", () => {
  const root = parseXml(`<?xml version="1.0"?>
<Ui a="1&amp;2">
  <!-- <Script file="commented.lua"/> -->
  <Script file='x.lua'/>
  <t>&lt;b&gt; &#65;&#x42;</t>
  <c><![CDATA[<raw>]]></c>
</Ui>`);
  assert.equal(root.local, "Ui");
  assert.equal(root.attrs.a, "1&2");
  const scripts = childElements(root, "Script");
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]!.attrs.file, "x.lua");
  assert.equal(scripts[0]!.line, 4);
  assert.equal(textContent(childElements(root, "t")[0]!), "<b> AB");
  assert.equal(textContent(childElements(root, "c")[0]!), "<raw>");
});

test("xml: namespace prefix is split off", () => {
  const root = parseXml(`<x:a xmlns:x="u"><x:b r:id="rId1"/></x:a>`);
  assert.equal(root.local, "a");
  assert.equal(childElements(root, "b")[0]!.attrs["r:id"], "rId1");
});

test("xml: DTDs and mismatched tags are rejected", () => {
  assert.throws(() => parseXml(`<!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>`));
  assert.throws(() => parseXml(`<a><b></a>`));
});

test("normalizePath", () => {
  assert.equal(normalizePath("libs\\Ace\\x.lua"), "libs/Ace/x.lua");
  assert.equal(normalizePath("a/./b/../c.lua"), "a/c.lua");
  assert.equal(normalizePath("../x"), null);
});

test("globToRegExp", () => {
  const g = (p: string) => globToRegExp(p);
  assert.ok(g("docs/**").test("docs/a/b.md"));
  assert.ok(g("docs/**").test("docs/x.md"));
  assert.ok(!g("docs/**").test("docsx/a"));
  assert.ok(g("**/*.lua").test("a.lua"));
  assert.ok(g("**/*.lua").test("a/b/c.lua"));
  assert.ok(!g("*.lua").test("a/b.lua"));
  assert.ok(g("CLAUDE.md").test("CLAUDE.md"));
  assert.ok(!g("CLAUDE.md").test("CLAUDExmd"));
  assert.ok(g("Guides/{wf,forever}/*.lua").test("Guides/wf/a.lua"));
});
