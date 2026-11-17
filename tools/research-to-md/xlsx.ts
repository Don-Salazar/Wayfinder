// Read cell values and hyperlinks from an .xlsx file. Only the parts needed
// for a faithful text conversion are read: workbook sheet list, shared
// strings, number formats (to recognise dates), sheet cells and hyperlinks.
// Nothing is executed or fetched: formulas are not evaluated (their cached
// value is used), external links are only recorded as text.

import { unzipSync, strFromU8 } from "fflate";
import { attrLocal, childElements, firstChild, parseXml, textContent, type XmlElement } from "../lib/xml.ts";

export interface Cell {
  /** Display text of the value (dates ISO, numbers as written, booleans TRUE/FALSE). */
  text: string;
  /** Hyperlink target, if the cell has one. */
  link?: string;
}

export interface Sheet {
  name: string;
  hidden: boolean;
  /** rowNumber (1-based) -> column index (0-based) -> cell */
  rows: Map<number, Map<number, Cell>>;
  /** Notes about values whose rendering involved a choice. */
  notes: string[];
}

const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colLetters(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function parseRef(ref: string): { row: number; col: number } {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`bad cell reference "${ref}"`);
  return { col: colIndex(m[1]!), row: Number(m[2]) };
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** True when an Excel number format code renders a date or time. */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, "") // quoted literals
    .replace(/\\./g, "") // escaped chars
    .replace(/\[[^\]]*\]/g, ""); // [Red], [$-409] etc.
  return /[dmyhs]/i.test(stripped) && !/^general$/i.test(stripped.trim());
}

/** Excel serial date -> ISO text. Date only when there is no time part. */
export function serialToIso(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round(serial * 86400000);
  const d = new Date(epoch + ms);
  const iso = d.toISOString();
  if (ms % 86400000 === 0) return iso.slice(0, 10);
  return d.getUTCSeconds() === 0 ? iso.slice(0, 16) : iso.slice(0, 19);
}

/**
 * Render a stored number. Excel keeps at most 15 significant digits; a value
 * written with more digits (binary float noise such as 0.30000000000000004)
 * is shown rounded to 15 digits, exactly as Excel displays it.
 */
export function renderNumber(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const r = Number(n.toPrecision(15));
  return String(r);
}

function readPart(files: Record<string, Uint8Array>, path: string): string | undefined {
  const data = files[path];
  return data ? strFromU8(data) : undefined;
}

function relsFor(files: Record<string, Uint8Array>, partPath: string): Map<string, { target: string; external: boolean }> {
  const dir = partPath.slice(0, partPath.lastIndexOf("/") + 1);
  const base = partPath.slice(dir.length);
  const xml = readPart(files, `${dir}_rels/${base}.rels`);
  const out = new Map<string, { target: string; external: boolean }>();
  if (!xml) return out;
  for (const rel of childElements(parseXml(xml), "Relationship")) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (!id || target === undefined) continue;
    const external = rel.attrs.TargetMode === "External";
    out.set(id, { target: external ? target : resolvePartPath(dir, target), external });
  }
  return out;
}

function resolvePartPath(dir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (dir + target).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

function sharedStringText(si: XmlElement): string {
  // Plain <t>, or rich-text runs <r><t>; phonetic runs <rPh> are not display text.
  const t = firstChild(si, "t");
  if (t) return textContent(t);
  return childElements(si, "r")
    .map((r) => {
      const rt = firstChild(r, "t");
      return rt ? textContent(rt) : "";
    })
    .join("");
}

export function readXlsx(data: Uint8Array): Sheet[] {
  let total = 0;
  const files = unzipSync(data, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_UNZIPPED_BYTES) throw new Error("xlsx: uncompressed size limit exceeded");
      return f.name.endsWith(".xml") || f.name.endsWith(".rels");
    },
  });

  const wbPath = "xl/workbook.xml";
  const wbXml = readPart(files, wbPath);
  if (!wbXml) throw new Error("xlsx: xl/workbook.xml not found");
  const wb = parseXml(wbXml);
  const wbRels = relsFor(files, wbPath);
  const wbPr = firstChild(wb, "workbookPr");
  const date1904 = wbPr?.attrs.date1904 === "1" || wbPr?.attrs.date1904 === "true";

  const ssXml = readPart(files, "xl/sharedStrings.xml");
  const shared = ssXml ? childElements(parseXml(ssXml), "si").map(sharedStringText) : [];

  // Style index -> is date format
  const dateStyles = new Set<number>();
  const stylesXml = readPart(files, "xl/styles.xml");
  if (stylesXml) {
    const st = parseXml(stylesXml);
    const custom = new Map<number, string>();
    const numFmts = firstChild(st, "numFmts");
    if (numFmts) for (const f of childElements(numFmts, "numFmt")) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? "");
    const cellXfs = firstChild(st, "cellXfs");
    if (cellXfs) {
      childElements(cellXfs, "xf").forEach((xf, i) => {
        const id = Number(xf.attrs.numFmtId ?? 0);
        const code = custom.get(id);
        if (code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id)) dateStyles.add(i);
      });
    }
  }

  const sheetsEl = firstChild(wb, "sheets");
  if (!sheetsEl) throw new Error("xlsx: workbook has no <sheets>");
  const sheets: Sheet[] = [];
  for (const s of childElements(sheetsEl, "sheet")) {
    const name = s.attrs.name ?? "";
    const rid = attrLocal(s, "id") ?? "";
    const rel = wbRels.get(rid);
    if (!rel) throw new Error(`xlsx: no relationship for sheet "${name}"`);
    const xml = readPart(files, rel.target);
    if (!xml) throw new Error(`xlsx: sheet part ${rel.target} missing for "${name}"`);
    const sheet: Sheet = { name, hidden: (s.attrs.state ?? "visible") !== "visible", rows: new Map(), notes: [] };
    readSheet(parseXml(xml), relsFor(files, rel.target), sheet, shared, dateStyles, date1904);
    sheets.push(sheet);
  }
  return sheets;
}

function readSheet(
  ws: XmlElement,
  rels: Map<string, { target: string; external: boolean }>,
  sheet: Sheet,
  shared: string[],
  dateStyles: Set<number>,
  date1904: boolean,
): void {
  const data = firstChild(ws, "sheetData");
  let lastRow = 0;
  for (const rowEl of data ? childElements(data, "row") : []) {
    const rowNum = rowEl.attrs.r ? Number(rowEl.attrs.r) : lastRow + 1;
    lastRow = rowNum;
    let lastCol = -1;
    for (const c of childElements(rowEl, "c")) {
      let col: number;
      if (c.attrs.r) {
        const ref = parseRef(c.attrs.r);
        if (ref.row !== rowNum) throw new Error(`xlsx: cell ${c.attrs.r} inside row ${rowNum}`);
        col = ref.col;
      } else col = lastCol + 1;
      lastCol = col;
      const text = cellText(c, shared, dateStyles, date1904, sheet, rowNum, col);
      if (text === "") continue;
      setCell(sheet, rowNum, col, { text });
    }
  }

  const hls = firstChild(ws, "hyperlinks");
  for (const h of hls ? childElements(hls, "hyperlink") : []) {
    const rid = attrLocal(h, "id");
    let link: string | undefined;
    if (rid) link = rels.get(rid)?.target;
    const location = h.attrs.location;
    if (location) link = (link ?? "") + "#" + location;
    if (!link || !h.attrs.ref) {
      sheet.notes.push(`hyperlink at ${h.attrs.ref ?? "?"} has no resolvable target`);
      continue;
    }
    const [a, b] = h.attrs.ref.split(":");
    const from = parseRef(a!);
    const to = b ? parseRef(b) : from;
    for (let r = from.row; r <= to.row; r++)
      for (let col = from.col; col <= to.col; col++) {
        const existing = sheet.rows.get(r)?.get(col);
        if (existing) existing.link = link;
        else {
          const display = h.attrs.display ?? "";
          setCell(sheet, r, col, { text: "", link });
          if (display) sheet.notes.push(`hyperlink at ${colLetters(col)}${r} has display text "${display}" but an empty cell`);
        }
      }
  }
}

function setCell(sheet: Sheet, row: number, col: number, cell: Cell): void {
  let r = sheet.rows.get(row);
  if (!r) sheet.rows.set(row, (r = new Map()));
  r.set(col, cell);
}

function cellText(
  c: XmlElement,
  shared: string[],
  dateStyles: Set<number>,
  date1904: boolean,
  sheet: Sheet,
  row: number,
  col: number,
): string {
  const t = c.attrs.t ?? "n";
  const vEl = firstChild(c, "v");
  const v = vEl ? textContent(vEl) : undefined;
  const where = `${colLetters(col)}${row}`;
  if (firstChild(c, "f") && v === undefined) {
    sheet.notes.push(`${where}: formula has no cached value; left empty`);
    return "";
  }
  switch (t) {
    case "s": {
      const s = shared[Number(v)];
      if (s === undefined) throw new Error(`xlsx: shared string ${v} missing (${sheet.name}!${where})`);
      return s;
    }
    case "inlineStr": {
      const is = firstChild(c, "is");
      return is ? sharedStringText(is) : "";
    }
    case "str":
      return v ?? "";
    case "b":
      return v === undefined ? "" : v === "1" ? "TRUE" : "FALSE";
    case "e":
      return v ?? "";
    case "d":
      return v ?? ""; // ISO 8601 date stored as text
    default: {
      if (v === undefined || v === "") return "";
      if (dateStyles.has(Number(c.attrs.s ?? 0))) return serialToIso(Number(v), date1904);
      const out = renderNumber(v);
      if (out !== v) sheet.notes.push(`${where}: number stored as "${v}" rendered as "${out}"`);
      return out;
    }
  }
}
