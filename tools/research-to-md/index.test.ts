import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { parseCsv, toCsv } from "../lib/csv.ts";
import { sheetToTable, slugify } from "./convert.ts";
import { compareWithIndex, mdCell, parseResearchIndex, renderTabMarkdown } from "./markdown.ts";
import { run } from "./index.ts";
import { colIndex, colLetters, isDateFormatCode, readXlsx, renderNumber, serialToIso } from "./xlsx.ts";

const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function fixtureXlsx(): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="Fact list" sheetId="1" r:id="rId1"/><sheet name="Shen'dralas lists" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    ),
    "xl/sharedStrings.xml": strToU8(
      `<sst ${NS}><si><t>Name</t></si><si><t>Value</t></si><si><t>Source</t></si><si><t>Checked</t></si><si><r><t>rich </t></r><r><t>text</t></r></si><si><t>Wiki</t></si><si><t xml:space="preserve">two
lines | pipe</t></si></sst>`,
    ),
    "xl/styles.xml": strToU8(
      `<styleSheet ${NS}><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="#,##0"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<worksheet ${NS}><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" s="2"><v>1400</v></c><c r="C2" t="s"><v>5</v></c><c r="D2" s="1"><v>46336</v></c></row>
<row r="3"><c r="A3" s="0"/><c r="B3"/></row>
<row r="4"><c r="A4" t="b"><v>1</v></c><c r="B4"><v>0.30000000000000004</v></c><c r="C4" t="inlineStr"><is><t>inline</t></is></c></row>
<row r="5"><c r="A5" t="s"><v>6</v></c><c r="B5" s="2"><f>SUM(B2:B4)</f><v>1400.3</v></c><c r="C5"><f>NOW()</f></c><c r="F5" t="str"><v>far</v></c></row>
</sheetData><hyperlinks><hyperlink ref="C2" r:id="rId1"/></hyperlinks></worksheet>`,
    ),
    "xl/worksheets/_rels/sheet1.xml.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/hyperlink" Target="https://example.org/wiki?a=1&amp;b=2" TargetMode="External"/></Relationships>`,
    ),
    "xl/worksheets/sheet2.xml": strToU8(`<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>5</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c></row></sheetData></worksheet>`),
  };
  return zipSync(files);
}

test("column letters and references", () => {
  assert.equal(colIndex("A"), 0);
  assert.equal(colIndex("AA"), 26);
  assert.equal(colLetters(27), "AB");
});

test("number and date rendering", () => {
  assert.equal(renderNumber("400"), "400");
  assert.equal(renderNumber("0.30000000000000004"), "0.3");
  assert.equal(renderNumber("12.5"), "12.5");
  assert.equal(serialToIso(46336, false), "2026-11-10");
  assert.equal(serialToIso(46336.5, false), "2026-11-10T12:00");
  assert.ok(isDateFormatCode("yyyy-mm-dd"));
  assert.ok(!isDateFormatCode("#,##0"));
  assert.ok(!isDateFormatCode('0.0 "days"'));
});

test("readXlsx: values, dates, booleans, formulas, links, hidden tabs", () => {
  const sheets = readXlsx(fixtureXlsx());
  assert.deepEqual(sheets.map((s) => [s.name, s.hidden]), [["Fact list", false], ["Shen'dralas lists", true]]);
  const s = sheets[0]!;
  const cell = (r: number, c: number) => s.rows.get(r)?.get(c);
  assert.equal(cell(2, 0)?.text, "rich text");
  assert.equal(cell(2, 1)?.text, "1400");
  assert.deepEqual(cell(2, 2), { text: "Wiki", link: "https://example.org/wiki?a=1&b=2" });
  assert.equal(cell(2, 3)?.text, "2026-11-10");
  assert.equal(cell(4, 0)?.text, "TRUE");
  assert.equal(cell(4, 1)?.text, "0.3");
  assert.equal(cell(4, 2)?.text, "inline");
  assert.equal(cell(5, 1)?.text, "1400.3");
  assert.equal(cell(5, 2), undefined); // formula without cached value
  assert.ok(s.notes.some((n) => n.includes("C5") && n.includes("no cached value")));
  assert.ok(s.notes.some((n) => n.includes("0.30000000000000004")));
});

test("sheetToTable: row numbers kept, link column added, empty rows skipped", () => {
  const t = sheetToTable(readXlsx(fixtureXlsx())[0]!);
  assert.deepEqual(t.header, ["row", "Name", "Value", "Source", "Source (link)", "Checked", "col_E", "col_F"]);
  assert.deepEqual(t.records.map((r) => r[0]), ["2", "4", "5"]);
  assert.deepEqual(t.records[0], ["2", "rich text", "1400", "Wiki", "https://example.org/wiki?a=1&b=2", "2026-11-10", "", ""]);
  assert.equal(t.records[2]![7], "far");
  assert.ok(t.notes.some((n) => n.includes("column F")));
});

test("sheetToTable: headerless tab keeps every row as data", () => {
  const t = sheetToTable(readXlsx(fixtureXlsx())[1]!, true);
  assert.deepEqual(t.header, ["row", "col_A"]);
  assert.deepEqual(t.records, [["1", "Wiki"], ["2", "Source"]]);
});

test("slugify", () => {
  assert.equal(slugify("Shen'dralas quests"), "shendralas-quests");
  assert.equal(slugify("Racials, Races"), "racials-races");
  assert.equal(slugify("XP table"), "xp-table");
});

test("markdown escaping", () => {
  assert.equal(mdCell("a | b\nc"), "a \\| b<br>c");
  assert.equal(mdCell("<b> & *x*"), "&lt;b&gt; &amp; \\*x\\*");
  assert.equal(mdCell("https://x.org/a|b"), "<https://x.org/a%7Cb>");
  const md = renderTabMarkdown({ name: "XP table", slug: "xp-table", hidden: false }, [["row", "Level"], ["2", "1"]]);
  assert.match(md, /1 rows/);
  assert.match(md, /edit the CSV, not this file/);
  assert.match(md, /2026-11-15/);
  assert.match(md, /\| 2 \| 1 \|/);
});

test("RESEARCH_INDEX parsing and comparison", () => {
  const idx = parseResearchIndex(`# x\n\n## Tabs\n\n| Tab | Rows | What |\n|---|---|---|\n| Facts | 254 | a |\n| Route | — | b |\n| Racials, Races | 38 / 10 | c |\n\n## Next\n| Other | 1 |\n`);
  assert.deepEqual([...idx], [["Facts", 254], ["Route", null], ["Racials", 38], ["Races", 10]]);
  const diffs = compareWithIndex(idx, [
    { name: "Facts", rows: 254, hidden: false },
    { name: "Route", rows: 7, hidden: false },
    { name: "Racials", rows: 37, hidden: false },
    { name: "Extra", rows: 1, hidden: true },
  ]);
  assert.equal(diffs.length, 4);
  assert.ok(diffs.some((d) => d.includes("Races") && d.includes("not in the workbook")));
  assert.ok(diffs.some((d) => d.includes("Racials") && d.includes("38")));
});

test("run: imports once, refuses to overwrite without --force, regenerates Markdown from CSV", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-research-"));
  try {
    const xlsx = join(dir, "w.xlsx");
    writeFileSync(xlsx, fixtureXlsx());
    const quiet = () => {};
    run({ researchDir: dir, fromXlsx: xlsx, log: quiet });
    const csvPath = join(dir, "csv", "fact-list.csv");
    assert.ok(existsSync(csvPath));
    assert.ok(existsSync(join(dir, "shendralas-lists.md")));
    assert.throws(() => run({ researchDir: dir, fromXlsx: xlsx, log: quiet }), /refusing to overwrite/);

    // CSV edits are the source of truth: Markdown follows them.
    const rows = parseCsv(readFileSync(csvPath, "utf8"));
    rows[1]![2] = "1500";
    writeFileSync(csvPath, toCsv(rows));
    run({ researchDir: dir, log: quiet });
    assert.match(readFileSync(join(dir, "fact-list.md"), "utf8"), /\| 2 \| rich text \| 1500 \|/);
    assert.match(readFileSync(join(dir, "README.md"), "utf8"), /Shen'dralas lists \(hidden\)/);

    run({ researchDir: dir, fromXlsx: xlsx, force: true, log: quiet });
    assert.match(readFileSync(csvPath, "utf8"), /^2,rich text,1400,/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
