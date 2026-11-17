// WoW addon manifest model: TOC selection, TOC line directives, XML
// <Script>/<Include> expansion, and file resolution against the files on disk.
//
// Rules implemented (sources: warcraft.wiki.gg "TOC format", read 2026-11-16,
// and the layout of the shipped upstream tree; see resolveXmlRef below):
// - The client picks <Name>_<Game>.toc, then <Name>_<Family>.toc, then <Name>.toc.
// - "#" starts a comment line, "## Key: Value" is metadata, anything else is a file.
// - "[AllowLoadGameType a,b]" / "[ExcludeLoadGameType a,b]" filter a line by game
//   type (values case-insensitive; if no listed value is a known game type the
//   Allow condition passes). "[Family]", "[Game]", "[TextLocale]" are variables.
// - TOC paths are relative to the addon folder.
// - XML <Script file>/<Include file> paths are tried relative to the XML file's
//   folder first, then relative to the addon folder (see XML_RESOLUTION below).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles, normalizePath } from "../lib/files.ts";
import { attrLocal, parseXml, type XmlElement } from "../lib/xml.ts";

export const GAME_TYPES = ["standard", "camelot", "vanilla", "tbc", "wrath", "cata", "mists"] as const;
export type GameType = (typeof GAME_TYPES)[number];

/** All game type names the client knows (wiki), with aliases mapped. */
const KNOWN_GAME_TYPES: Record<string, string> = {
  standard: "standard",
  forever: "camelot",
  camelot: "camelot",
  mists: "mists",
  cata: "cata",
  wrath: "wrath",
  tbc: "tbc",
  vanilla: "vanilla",
  plunderstorm: "plunderstorm",
  wowlabs: "plunderstorm",
  wowhack: "wowhack",
};

const FAMILY: Record<GameType, "Mainline" | "Classic"> = {
  standard: "Mainline",
  camelot: "Mainline",
  vanilla: "Classic",
  tbc: "Classic",
  wrath: "Classic",
  cata: "Classic",
  mists: "Classic",
};

/** TOC suffixes tried in priority order (game suffixes first, then family). */
export const TOC_SUFFIXES: Record<GameType, string[]> = {
  standard: ["Standard", "Mainline"],
  camelot: ["Forever", "Camelot", "Mainline"],
  vanilla: ["Vanilla", "Classic"],
  tbc: ["TBC", "Classic"],
  wrath: ["Wrath", "Classic"],
  cata: ["Cata", "Classic"],
  mists: ["Mists", "Classic"],
};

const GAME_VARIABLE: Record<GameType, string> = {
  standard: "Standard",
  camelot: "Camelot",
  vanilla: "Vanilla",
  tbc: "TBC",
  wrath: "Wrath",
  cata: "Cata",
  mists: "Mists",
};

export type FindingKind = "missing" | "case" | "xml-error" | "unknown-directive" | "outside-addon";

export interface Finding {
  gameType: GameType;
  kind: FindingKind;
  /** File containing the reference (TOC or XML), relative to the addon root. */
  from: string;
  line: number;
  /** The reference as written. */
  ref: string;
  /** For "case": the path as found on disk. */
  actual?: string;
  detail: string;
}

export interface LoadedFile {
  /** Path as it exists on disk (actual case), or the normalised reference if missing. */
  path: string;
  kind: "toc" | "xml" | "lua" | "other";
  from: string;
  line: number;
  exists: boolean;
  /** How an XML reference resolved: relative to the XML folder or the addon root. */
  via?: "toc" | "xml-dir" | "addon-root";
}

export interface LoadResult {
  gameType: GameType;
  toc: string | null;
  files: LoadedFile[];
  findings: Finding[];
}

export interface TocLine {
  line: number;
  path: string;
  directives: { name: string; value?: string }[];
  unknown: string[];
}

const VARIABLES = new Set(["family", "game", "textlocale", "regionaltextlocale"]);
const DIRECTIVES = new Set([
  "allowload",
  "allowloadgametype",
  "excludeloadgametype",
  "allowloadtextlocale",
  "allowloadenvironment",
]);

/** Split a TOC/XML file reference into path and inline directives. */
export function parseFileRef(raw: string, line = 0): TocLine {
  const directives: { name: string; value?: string }[] = [];
  const unknown: string[] = [];
  const path = raw
    .replace(/\[([A-Za-z]+)(?:\s+([^\]]*))?\]/g, (m, name: string, value?: string) => {
      const n = name.toLowerCase();
      if (DIRECTIVES.has(n)) {
        directives.push(value === undefined ? { name: n } : { name: n, value: value.trim() });
        return "";
      }
      if (VARIABLES.has(n) && value === undefined) return m; // substituted per game type
      unknown.push(m);
      return m;
    })
    .trim();
  return { line, path, directives, unknown };
}

export interface ParsedToc {
  metadata: Map<string, string>;
  files: TocLine[];
}

export function parseToc(text: string): ParsedToc {
  const metadata = new Map<string, string>();
  const files: TocLine[] = [];
  text.split(/\r\n|\r|\n/).forEach((rawLine, i) => {
    const line = rawLine.slice(0, 1024).trim();
    if (!line) return;
    if (line.startsWith("##")) {
      const m = /^##\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
      if (m) metadata.set(m[1]!, m[2]!);
      return;
    }
    if (line.startsWith("#")) return;
    files.push(parseFileRef(line, i + 1));
  });
  return { metadata, files };
}

function listValues(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Does a line with these directives load for this game type? */
export function lineApplies(directives: TocLine["directives"], gameType: GameType): boolean {
  for (const d of directives) {
    if (d.name === "allowloadgametype") {
      const vals = listValues(d.value).map((v) => KNOWN_GAME_TYPES[v]).filter((v): v is string => !!v);
      if (vals.length && !vals.includes(gameType)) return false;
    } else if (d.name === "excludeloadgametype") {
      const vals = listValues(d.value).map((v) => KNOWN_GAME_TYPES[v]);
      if (vals.includes(gameType)) return false;
    }
    // AllowLoadTextLocale: we check all locales, so the line counts as loaded.
  }
  return true;
}

export function substituteVariables(path: string, gameType: GameType): string {
  return path.replace(/\[([A-Za-z]+)\]/g, (m, name: string) => {
    switch (name.toLowerCase()) {
      case "family":
        return FAMILY[gameType];
      case "game":
        return GAME_VARIABLE[gameType];
      case "textlocale":
      case "regionaltextlocale":
        return "enUS";
      default:
        return m;
    }
  });
}

/** File index: exact path set plus lower-case -> actual path. */
export class FileIndex {
  readonly exact: Set<string>;
  readonly lower = new Map<string, string>();
  constructor(paths: Iterable<string>) {
    this.exact = new Set(paths);
    for (const p of this.exact) this.lower.set(p.toLowerCase(), p);
  }
  static fromDisk(root: string): FileIndex {
    return new FileIndex(listFiles(root));
  }
  /** Case-insensitive lookup: returns the on-disk path or undefined. */
  find(path: string): string | undefined {
    return this.exact.has(path) ? path : this.lower.get(path.toLowerCase());
  }
}

/** TOC base names present in root, e.g. "RXPGuides" for RXPGuides_TBC.toc. */
export function addonNames(index: FileIndex): string[] {
  const all = Object.values(TOC_SUFFIXES).flat();
  const names = new Set<string>();
  for (const p of index.exact) {
    if (p.includes("/") || !/\.toc$/i.test(p)) continue;
    let base = p.slice(0, -4);
    for (const s of all) if (base.toLowerCase().endsWith("_" + s.toLowerCase())) base = base.slice(0, -(s.length + 1));
    names.add(base);
  }
  return [...names].sort();
}

/** Which TOC the client would load for this game type (null: addon does not load). */
export function selectToc(index: FileIndex, addon: string, gameType: GameType): string | null {
  for (const s of TOC_SUFFIXES[gameType]) {
    const hit = index.find(`${addon}_${s}.toc`);
    if (hit) return hit;
  }
  return index.find(`${addon}.toc`) ?? null;
}

/**
 * XML_RESOLUTION: a <Script file>/<Include file> path is looked up relative to
 * the XML file's folder; if no such file exists, relative to the addon root.
 * Evidence: in the upstream tree at 22e6ce26 every one of the ~1,550 XML
 * references resolves under exactly one of the two rules (none under both,
 * none under neither), and the shipped DB/*.xml and Guides/GuideList-*.xml
 * (e.g. DB/forever.xml -> "DB/forever/quest.lua") only resolve against the
 * addon root, while libs/, locale/, UI/ and most lang/ XML only resolve
 * against their own folder. Untested in client: which rule wins if both match.
 */
export function resolveXmlRef(index: FileIndex, xmlPath: string, ref: string): { candidate: string; actual?: string; via: "xml-dir" | "addon-root" } | null {
  const dir = xmlPath.includes("/") ? xmlPath.slice(0, xmlPath.lastIndexOf("/")) : "";
  const candidates: { p: string | null; via: "xml-dir" | "addon-root" }[] = [
    { p: normalizePath(dir ? `${dir}/${ref}` : ref), via: "xml-dir" },
    { p: normalizePath(ref), via: "addon-root" },
  ];
  for (const c of candidates) {
    if (c.p === null) continue;
    const actual = index.find(c.p);
    if (actual) return { candidate: c.p, actual, via: c.via };
  }
  const first = candidates.find((c) => c.p !== null);
  return first ? { candidate: first.p!, via: first.via } : null;
}

function kindOf(path: string): LoadedFile["kind"] {
  const l = path.toLowerCase();
  return l.endsWith(".xml") ? "xml" : l.endsWith(".lua") ? "lua" : l.endsWith(".toc") ? "toc" : "other";
}

/** Strip "Interface\AddOns\<addon>\" so absolute paths to our own folder work. */
function stripAddonPrefix(ref: string, addon: string): { path: string; outside: boolean } {
  const n = ref.replace(/\\/g, "/");
  const m = /^interface\/addons\/([^/]+)\/(.*)$/i.exec(n);
  if (!m) return { path: n, outside: false };
  return m[1]!.toLowerCase() === addon.toLowerCase() ? { path: m[2]!, outside: false } : { path: n, outside: true };
}

export interface LoadOptions {
  root: string;
  addon?: string;
  index?: FileIndex;
  /** Read a file's text; defaults to the file system. */
  read?: (relPath: string) => string;
}

/** Load-ordered list of files for one game type, with findings. */
export function loadOrder(gameType: GameType, opts: LoadOptions): LoadResult {
  const index = opts.index ?? FileIndex.fromDisk(opts.root);
  const read = opts.read ?? ((p: string) => readFileSync(join(opts.root, p), "utf8"));
  const addon = opts.addon ?? addonNames(index)[0];
  const result: LoadResult = { gameType, toc: null, files: [], findings: [] };
  if (!addon) return result;
  const toc = selectToc(index, addon, gameType);
  result.toc = toc;
  if (!toc) return result;
  result.files.push({ path: toc, kind: "toc", from: "", line: 0, exists: true, via: "toc" });

  const finding = (f: Omit<Finding, "gameType">) => result.findings.push({ gameType, ...f });
  const visited = new Set<string>();

  const addRef = (from: string, line: number, rawRef: TocLine, fromXml: boolean) => {
    for (const u of rawRef.unknown) finding({ kind: "unknown-directive", from, line, ref: rawRef.path, detail: `unknown bracket token ${u}` });
    if (!lineApplies(rawRef.directives, gameType)) return;
    const ref = substituteVariables(rawRef.path, gameType);
    const { path: own, outside } = stripAddonPrefix(ref, addon);
    if (outside) {
      finding({ kind: "outside-addon", from, line, ref, detail: "reference into another addon's folder; not checked" });
      return;
    }
    let candidate: string | null;
    let actual: string | undefined;
    let via: LoadedFile["via"];
    if (fromXml) {
      const r = resolveXmlRef(index, from, own);
      candidate = r?.candidate ?? null;
      actual = r?.actual;
      via = r?.via;
    } else {
      candidate = normalizePath(own);
      actual = candidate === null ? undefined : index.find(candidate);
      via = "toc";
    }
    if (candidate === null) {
      finding({ kind: "missing", from, line, ref, detail: "path escapes the addon folder" });
      return;
    }
    if (!actual) {
      finding({ kind: "missing", from, line, ref, detail: fromXml ? `not found relative to ${from}'s folder or the addon root` : "file not found" });
      result.files.push({ path: candidate, kind: kindOf(candidate), from, line, exists: false, ...(via ? { via } : {}) });
      return;
    }
    if (actual !== candidate) {
      finding({ kind: "case", from, line, ref, actual, detail: `case differs from disk: "${candidate}" vs "${actual}"` });
    }
    result.files.push({ path: actual, kind: kindOf(actual), from, line, exists: true, ...(via ? { via } : {}) });
    if (kindOf(actual) === "xml") loadXml(actual);
  };

  const loadXml = (xmlPath: string) => {
    if (visited.has(xmlPath)) return;
    visited.add(xmlPath);
    let root: XmlElement;
    try {
      root = parseXml(read(xmlPath));
    } catch (e) {
      finding({ kind: "xml-error", from: xmlPath, line: 0, ref: xmlPath, detail: (e as Error).message });
      return;
    }
    const walk = (el: XmlElement) => {
      if (el.local === "Script" || el.local === "Include") {
        const file = attrLocal(el, "file");
        if (file !== undefined) addRef(xmlPath, el.line, parseFileRef(file, el.line), true);
      }
      for (const c of el.children) if (typeof c !== "string") walk(c);
    };
    walk(root);
  };

  for (const l of parseToc(read(toc)).files) addRef(toc, l.line, l, false);
  return result;
}

/** Convenience for other tools: load-ordered file paths per game type. */
export function loadOrderByGameType(root: string, addon?: string): Map<GameType, string[]> {
  const index = FileIndex.fromDisk(root);
  const out = new Map<GameType, string[]>();
  for (const g of GAME_TYPES) {
    const r = loadOrder(g, { root, index, ...(addon ? { addon } : {}) });
    out.set(g, r.files.filter((f) => f.exists).map((f) => f.path));
  }
  return out;
}
