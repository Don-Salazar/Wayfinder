// RFC 4180 CSV with "\n" record separators. Fields are quoted only when they
// contain a comma, a quote, CR or LF, or leading/trailing whitespace.

export function csvField(value: string): string {
  if (/[",\r\n]/.test(value) || value !== value.trim()) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

/** Parse CSV text (RFC 4180; accepts \n or \r\n record separators). */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  let fieldStarted = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
      i++;
    } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStarted = false;
      i += ch === "\r" ? 2 : 1;
    } else {
      field += ch;
      fieldStarted = true;
      i++;
    }
  }
  if (quoted) throw new Error("CSV: unterminated quoted field");
  if (fieldStarted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
