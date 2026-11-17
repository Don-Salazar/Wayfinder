// Minimal, non-validating XML reader for the small, machine-written XML we
// read (SpreadsheetML parts, WoW UI XML). It builds a plain element tree.
// Deliberately unsupported: DTDs (rejected, so no entity expansion), external
// entities, processing of namespaces beyond splitting the prefix.

export interface XmlElement {
  /** Qualified name as written, e.g. "x:row" or "Script". */
  name: string;
  /** Name without namespace prefix, e.g. "row". */
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** 1-based line of the start tag in the source. */
  line: number;
}
export type XmlNode = XmlElement | string;

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

function localName(q: string): string {
  const i = q.indexOf(":");
  return i < 0 ? q : q.slice(i + 1);
}

export class XmlError extends Error {}

/** Parse an XML document and return its root element. */
export function parseXml(src: string): XmlElement {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const root: XmlElement = { name: "#document", local: "#document", attrs: {}, children: [], line: 1 };
  const stack: XmlElement[] = [root];
  let pos = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let i = pos; i < to; i++) if (src.charCodeAt(i) === 10) line++;
    pos = to;
  };
  const top = () => stack[stack.length - 1]!;

  while (pos < src.length) {
    const lt = src.indexOf("<", pos);
    if (lt < 0) {
      const text = src.slice(pos);
      if (text.trim() && stack.length > 1) top().children.push(decodeEntities(text));
      advance(src.length);
      break;
    }
    if (lt > pos) {
      const text = src.slice(pos, lt);
      if (stack.length > 1) top().children.push(decodeEntities(text));
      advance(lt);
    }
    if (src.startsWith("<!--", pos)) {
      const end = src.indexOf("-->", pos + 4);
      if (end < 0) throw new XmlError(`unterminated comment at line ${line}`);
      advance(end + 3);
    } else if (src.startsWith("<![CDATA[", pos)) {
      const end = src.indexOf("]]>", pos + 9);
      if (end < 0) throw new XmlError(`unterminated CDATA at line ${line}`);
      top().children.push(src.slice(pos + 9, end));
      advance(end + 3);
    } else if (src.startsWith("<?", pos)) {
      const end = src.indexOf("?>", pos + 2);
      if (end < 0) throw new XmlError(`unterminated processing instruction at line ${line}`);
      advance(end + 2);
    } else if (src.startsWith("<!", pos)) {
      throw new XmlError(`DTD/declarations are not supported (line ${line})`);
    } else if (src.startsWith("</", pos)) {
      const end = src.indexOf(">", pos);
      if (end < 0) throw new XmlError(`unterminated end tag at line ${line}`);
      const name = src.slice(pos + 2, end).trim();
      const open = stack.pop();
      if (!open || open === root || open.name !== name) {
        throw new XmlError(`mismatched end tag </${name}> at line ${line}`);
      }
      advance(end + 1);
    } else {
      const startLine = line;
      // Find the end of the tag, skipping quoted attribute values.
      let i = pos + 1;
      let quote = "";
      for (; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
      }
      if (i >= src.length) throw new XmlError(`unterminated start tag at line ${line}`);
      let body = src.slice(pos + 1, i);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) throw new XmlError(`malformed tag at line ${line}`);
      const name = m[1]!;
      const attrs: Record<string, string> = {};
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      const rest = body.slice(name.length);
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(rest))) attrs[am[1]!] = decodeEntities(am[3] ?? am[4] ?? "");
      const el: XmlElement = { name, local: localName(name), attrs, children: [], line: startLine };
      top().children.push(el);
      advance(i + 1);
      if (!selfClosing) stack.push(el);
    }
  }
  if (stack.length > 1) throw new XmlError(`unclosed element <${top().name}>`);
  const first = root.children.find((c): c is XmlElement => typeof c !== "string");
  if (!first) throw new XmlError("no root element");
  return first;
}

export function childElements(el: XmlElement, local?: string): XmlElement[] {
  return el.children.filter(
    (c): c is XmlElement => typeof c !== "string" && (local === undefined || c.local === local),
  );
}

export function firstChild(el: XmlElement, local: string): XmlElement | undefined {
  return childElements(el, local)[0];
}

/** Concatenated text content of an element and its descendants. */
export function textContent(el: XmlElement): string {
  return el.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}

/** Attribute lookup by local name, ignoring any namespace prefix. */
export function attrLocal(el: XmlElement, local: string): string | undefined {
  if (local in el.attrs) return el.attrs[local];
  for (const [k, v] of Object.entries(el.attrs)) if (localName(k) === local) return v;
  return undefined;
}
