// Sheet -> CSV table. Faithful: no values are changed, dropped or reordered.
// Rows with no values at all are not emitted; the `row` column keeps the
// spreadsheet row number so `research:<tab>#<row>` references still resolve.

import { colLetters, type Sheet } from "./xlsx.ts";

export const LINK_SUFFIX = " (link)";

export interface TabTable {
  /** CSV header, starting with "row". */
  header: string[];
  /** Data records; first field is the spreadsheet row number. */
  records: string[][];
  /** Spreadsheet row number of the header row (0 when the sheet is empty). */
  headerRow: number;
  notes: string[];
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function rowHasContent(cells: Map<number, { text: string; link?: string }> | undefined): boolean {
  if (!cells) return false;
  for (const c of cells.values()) if (c.text !== "" || c.link) return true;
  return false;
}

/**
 * @param headerless the sheet has no header row (e.g. a hidden list of
 *   validation values): every row is data and columns are named col_A, col_B...
 */
export function sheetToTable(sheet: Sheet, headerless = false): TabTable {
  const notes = [...sheet.notes];
  const rowNums = [...sheet.rows.keys()].filter((r) => rowHasContent(sheet.rows.get(r))).sort((a, b) => a - b);
  if (rowNums.length === 0) return { header: ["row"], records: [], headerRow: 0, notes };

  const headerRow = headerless ? 0 : rowNums[0]!;
  if (headerRow > 1) notes.push(`header taken from row ${headerRow} (rows above it are empty)`);
  const headerCells = sheet.rows.get(headerRow) ?? new Map();

  let maxCol = -1;
  const linkCols = new Set<number>();
  for (const r of rowNums) {
    for (const [col, cell] of sheet.rows.get(r)!) {
      if (cell.text !== "" || cell.link) maxCol = Math.max(maxCol, col);
      if (cell.link && r !== headerRow) linkCols.add(col);
    }
  }

  const header = ["row"];
  const seen = new Map<string, number>();
  for (let col = 0; col <= maxCol; col++) {
    const h = headerCells.get(col);
    let name = h?.text ?? "";
    if (name === "") {
      name = `col_${colLetters(col)}`;
      if (!headerless) notes.push(`column ${colLetters(col)} is within the data range but has no header text; named "${name}"`);
    }
    if (h?.link) notes.push(`header cell ${colLetters(col)}${headerRow} links to ${h.link}; link not kept as a column`);
    seen.set(name, (seen.get(name) ?? 0) + 1);
    header.push(name);
    if (linkCols.has(col)) header.push(name + LINK_SUFFIX);
  }
  for (const [name, n] of seen) if (n > 1) notes.push(`header "${name}" occurs ${n} times`);
  if (header.indexOf("row", 1) > 0) notes.push(`a sheet column is itself named "row"`);
  for (const name of seen.keys())
    if (name.endsWith(LINK_SUFFIX)) notes.push(`sheet header "${name}" ends like a generated link column`);

  const records: string[][] = [];
  for (const r of rowNums) {
    if (r === headerRow) continue;
    const cells = sheet.rows.get(r)!;
    const rec = [String(r)];
    for (let col = 0; col <= maxCol; col++) {
      const c = cells.get(col);
      rec.push(c?.text ?? "");
      if (linkCols.has(col)) rec.push(c?.link ?? "");
    }
    records.push(rec);
  }
  return { header, records, headerRow, notes };
}
