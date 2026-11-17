// tags.json staleness check: each listed reader line must still mention its
// tag, so an upstream sync that moves or removes a reader is noticed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTags, type TagEntry } from "./vocab.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cache = new Map<string, string[]>();
function lineOf(ref: string): string {
  const m = /^(.+):(\d+)$/.exec(ref);
  assert.ok(m, `bad reader reference ${ref}`);
  const [, file, n] = m;
  let lines = cache.get(file!);
  if (!lines) {
    lines = readFileSync(join(ROOT, file!), "utf8").split(/\r\n|\r|\n/);
    cache.set(file!, lines);
  }
  const text = lines[Number(n) - 1];
  assert.ok(text !== undefined, `${ref}: no such line`);
  return text;
}

function mentions(e: TagEntry, text: string): boolean {
  if (e.mentions) return text.includes(e.mentions);
  const esc = e.tag.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(?:\\.|\\[")${esc}(?![A-Za-z0-9_])`).test(text);
}

const tags = loadTags();

for (const [section, list] of [["headerTags", tags.headerTags], ["stepTags", tags.stepTags]] as const) {
  test(`tags.json ${section}: every reader line still reads its tag`, () => {
    const bad = list.filter((e) => !mentions(e, lineOf(e.reader))).map((e) => `#${e.tag} @ ${e.reader}: ${lineOf(e.reader).trim()}`);
    assert.deepEqual(bad, [], "stale reader lines (re-find the reader in source and update tags.json)");
  });
  test(`tags.json ${section}: no duplicate tags`, () => {
    const seen = new Set<string>();
    const dups = list.map((e) => e.tag).filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
    assert.deepEqual(dups, []);
  });
}

test("tags.json conditionExtras: the cited guide line uses the token", () => {
  for (const e of tags.conditionExtras) assert.ok(lineOf(e.source).includes(e.token), `${e.token} @ ${e.source}`);
});
