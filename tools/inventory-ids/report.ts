// Builds the inventory result (findings + totals) and renders JSON/Markdown.

import { CATEGORIES, RULES } from "./rules.ts";
import type { Hit, SourceFile, Status, TreeInfo } from "./scan.ts";

export interface Finding {
  category: string;
  rule: string;
  id: string;
  file: string;
  /** First line (0 for file-level findings). */
  line: number;
  status: Status;
  /** Occurrences merged into this record (aggregated rules merge per file and identifier). */
  count: number;
  /** Raw RXP/RestedXP occurrences covered. */
  raw: number;
  text: string;
  detail?: string;
  /** Aggregated records: up to 10 line numbers. */
  lines?: number[];
}

export type StatusCounts = Record<Status | "total", number>;

export interface CategorySummary {
  id: string;
  num: number;
  title: string;
  note: string;
  occurrences: StatusCounts;
  raw: StatusCounts;
  distinct: number;
}

export interface CouplingRow {
  folder: string;
  status: Status;
  guideFiles: number;
  coupledFiles: number;
  entryPoints: Record<string, { files: number; calls: number }>;
}

export interface Inventory {
  tool: string;
  upstreamCommit: string;
  date: string;
  rawPattern: string;
  scope: { scanned: number; byStatus: Record<Status, number>; skipped: string };
  savedVariables: string[];
  addonNames: string[];
  addonGlobalCount: number;
  totals: { rawHits: number; rawClassified: number; rawUnclassified: number; findings: number; occurrences: number };
  categories: CategorySummary[];
  guideCoupling: CouplingRow[];
  files: { path: string; status: Status; loadedOn: string[]; raw: number }[];
  findings: Finding[];
}

const zero = (): StatusCounts => ({ forever: 0, other: 0, library: 0, total: 0 });
const AGGREGATE = new Set(RULES.filter((r) => r.aggregate).map((r) => r.id));
const CAT_NUM = new Map(CATEGORIES.map((c) => [c.id, c.num]));

export function buildInventory(
  files: SourceFile[],
  perFile: Map<string, { hits: Hit[]; rawTotal: number }>,
  tree: TreeInfo,
  meta: { upstreamCommit: string; date: string },
): Inventory {
  const status = new Map(files.map((f) => [f.path, f.status]));
  const findings: Finding[] = [];
  const cats = new Map<string, CategorySummary>(
    CATEGORIES.map((c) => [c.id, { id: c.id, num: c.num, title: c.title, note: c.note, occurrences: zero(), raw: zero(), distinct: 0 }]),
  );
  const distinct = new Map<string, Set<string>>();
  let rawHits = 0;
  let rawUnclassified = 0;

  for (const f of files) {
    const r = perFile.get(f.path);
    if (!r) continue;
    rawHits += r.rawTotal;
    const agg = new Map<string, Finding>();
    for (const h of r.hits) {
      const st = f.status;
      const c = cats.get(h.category)!;
      c.occurrences[st]++;
      c.occurrences.total++;
      c.raw[st] += h.raw;
      c.raw.total += h.raw;
      if (h.category === "unclassified") rawUnclassified += h.raw;
      (distinct.get(h.category) ?? distinct.set(h.category, new Set()).get(h.category)!).add(h.id);
      if (AGGREGATE.has(h.rule)) {
        const key = `${h.category}\0${h.rule}\0${h.id}`;
        const prev = agg.get(key);
        if (prev) {
          prev.count++;
          prev.raw += h.raw;
          if (prev.lines!.length < 10) prev.lines!.push(h.line);
          continue;
        }
        const nf: Finding = { category: h.category, rule: h.rule, id: h.id, file: h.file, line: h.line, status: st, count: 1, raw: h.raw, text: h.text, ...(h.detail ? { detail: h.detail } : {}), lines: [h.line] };
        agg.set(key, nf);
        findings.push(nf);
      } else {
        findings.push({ category: h.category, rule: h.rule, id: h.id, file: h.file, line: h.line, status: st, count: 1, raw: h.raw, text: h.text, ...(h.detail ? { detail: h.detail } : {}) });
      }
    }
  }
  for (const [id, s] of distinct) cats.get(id)!.distinct = s.size;
  findings.sort(
    (a, b) =>
      CAT_NUM.get(a.category)! - CAT_NUM.get(b.category)! ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0),
  );

  const byStatus: Record<Status, number> = { forever: 0, other: 0, library: 0 };
  for (const f of files) byStatus[f.status]++;

  return {
    tool: "tools/inventory-ids",
    upstreamCommit: meta.upstreamCommit,
    date: meta.date,
    rawPattern: "/restedxp|rxp/gi",
    scope: {
      scanned: files.length,
      byStatus,
      skipped: "untracked files; top-level node_modules, .tools, docs, tools, tests; non-Lua/XML/TOC; binary files",
    },
    savedVariables: tree.savedVars,
    addonNames: tree.addonNames,
    addonGlobalCount: tree.addonGlobals.size,
    totals: {
      rawHits,
      rawClassified: rawHits - rawUnclassified,
      rawUnclassified,
      findings: findings.length,
      occurrences: [...cats.values()].reduce((s, c) => s + c.occurrences.total, 0),
    },
    categories: [...cats.values()].sort((a, b) => a.num - b.num),
    guideCoupling: coupling(files, perFile),
    files: files.map((f) => ({ path: f.path, status: f.status, loadedOn: f.loadedOn, raw: perFile.get(f.path)?.rawTotal ?? 0 })),
    findings,
  };
}

function coupling(files: SourceFile[], perFile: Map<string, { hits: Hit[] }>): CouplingRow[] {
  const rows = new Map<string, CouplingRow>();
  for (const f of files) {
    if (!f.isGuide) continue;
    const folder = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
    const key = `${folder}\0${f.status}`;
    const row = rows.get(key) ?? { folder, status: f.status, guideFiles: 0, coupledFiles: 0, entryPoints: {} };
    rows.set(key, row);
    row.guideFiles++;
    const hits = (perFile.get(f.path)?.hits ?? []).filter((h) => h.category === "guide-coupling");
    if (hits.length) row.coupledFiles++;
    const seen = new Set<string>();
    for (const h of hits) {
      const ep = (row.entryPoints[h.id] ??= { files: 0, calls: 0 });
      ep.calls++;
      if (!seen.has(h.id)) {
        seen.add(h.id);
        ep.files++;
      }
    }
  }
  return [...rows.values()].sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : a.status < b.status ? -1 : a.status > b.status ? 1 : 0));
}

// ---------------------------------------------------------------- JSON

export function renderJson(inv: Inventory): string {
  // One finding per line keeps the file diffable and greppable.
  const { findings, files, ...head } = inv;
  const body = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  const lines = (arr: unknown[]) => arr.map((x) => "    " + JSON.stringify(x)).join(",\n");
  return `${body},\n  "files": [\n${lines(files)}\n  ],\n  "findings": [\n${lines(findings)}\n  ]\n}\n`;
}

// ---------------------------------------------------------------- Markdown

const esc = (s: string, max = 70) => {
  const t = s.length > max ? s.slice(0, max - 1) + "…" : s;
  return "`" + t.replace(/`/g, "'").replace(/\|/g, "\\|").replace(/\r?\n/g, " ") + "`";
};

interface IdStat {
  id: string;
  counts: StatusCounts;
  examples: string[];
  details: Set<string>;
}

function idStats(findings: Finding[], filter: (f: Finding) => boolean, examples = 3): IdStat[] {
  const m = new Map<string, IdStat>();
  for (const f of findings) {
    if (!filter(f)) continue;
    const s = m.get(f.id) ?? { id: f.id, counts: zero(), examples: [], details: new Set<string>() };
    m.set(f.id, s);
    s.counts[f.status] += f.count;
    s.counts.total += f.count;
    if (s.examples.length < examples) s.examples.push(`${f.file}${f.line ? ":" + f.line : ""}`);
    if (f.detail && s.details.size < 3) s.details.add(f.detail.length > 60 ? f.detail.slice(0, 59) + "…" : f.detail);
  }
  return [...m.values()].sort((a, b) => b.counts.total - a.counts.total || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const RENAME_CATS = ["toc", "savedvars", "globals", "frames", "slash", "bindings", "comms", "ace", "addon-folder", "registries"];

export function renderMarkdown(inv: Inventory, opts: { perCategory?: number; renameLimit?: number } = {}): string {
  const per = opts.perCategory ?? 25;
  const renameLimit = opts.renameLimit ?? 80;
  const o: string[] = [];
  const n = (x: number) => x.toLocaleString("en-US");
  o.push("# Identifier inventory (RXPGuides → Wayfinder rebrand, P1)");
  o.push("");
  o.push(`Upstream commit: \`${inv.upstreamCommit}\` · Date: ${inv.date} · Generated by \`npm run inventory:ids\` (tools/inventory-ids). Full list: \`identifier-inventory.json\`.`);
  o.push("");
  o.push(
    `Scope: ${n(inv.scope.scanned)} tracked Lua/XML/TOC files (${n(inv.scope.byStatus.forever)} loaded on Forever, ${n(inv.scope.byStatus.other)} not loaded on Forever, ${n(inv.scope.byStatus.library)} under \`libs/\`). Skipped: ${inv.scope.skipped}. "Loaded on Forever" = in the \`camelot\` load order from tools/check-manifests (plus \`Bindings.xml\`, which the client reads from the addon folder without a TOC entry).`,
  );
  o.push("");
  o.push(`Declared saved variables: ${inv.savedVariables.map((s) => "`" + s + "`").join(", ")}. Addon (TOC) name: ${inv.addonNames.map((s) => "`" + s + "`").join(", ")}. Globals the addon defines (static estimate): ${n(inv.addonGlobalCount)}.`);
  o.push("");
  o.push("## Coverage");
  o.push("");
  o.push(
    `Raw occurrences of \`${inv.rawPattern}\` in the scanned files: **${n(inv.totals.rawHits)}**. Claimed by a category: ${n(inv.totals.rawClassified)}. Unclassified (category 13): **${n(inv.totals.rawUnclassified)}**. Each source span belongs to at most one finding, so the per-category raw counts below add up to the raw total.`,
  );
  o.push("");
  o.push("## Summary");
  o.push("");
  o.push("Occurrences per category (one per matched span; aggregated rules still count every occurrence). \"RXP hits\" = raw RXP/RestedXP occurrences inside that category's spans.");
  o.push("");
  o.push("| # | Category | Loaded on Forever | Not loaded on Forever | Library (`libs/`) | Total | Distinct ids | RXP hits |");
  o.push("|---:|---|---:|---:|---:|---:|---:|---:|");
  for (const c of inv.categories)
    o.push(`| ${c.num} | ${c.title} | ${n(c.occurrences.forever)} | ${n(c.occurrences.other)} | ${n(c.occurrences.library)} | ${n(c.occurrences.total)} | ${n(c.distinct)} | ${n(c.raw.total)} |`);
  const tot = inv.categories.reduce((s, c) => s + c.raw.total, 0);
  o.push(`| | **All** | | | | ${n(inv.totals.occurrences)} | | ${n(tot)} |`);
  o.push("");

  // Rename list
  o.push("## Rename list: identifiers in files loaded on Forever");
  o.push("");
  o.push("Distinct identifiers per collision-relevant category, Forever-loaded files only, most frequent first. Counts are occurrences in Forever-loaded files.");
  o.push("");
  for (const id of RENAME_CATS) {
    const c = inv.categories.find((x) => x.id === id)!;
    const stats = idStats(inv.findings, (f) => f.category === id && f.status === "forever", 2);
    o.push(`### ${c.num}. ${c.title} — ${n(stats.length)} distinct`);
    o.push("");
    if (!stats.length) {
      o.push("None.");
      o.push("");
      continue;
    }
    const shown = stats.slice(0, renameLimit);
    o.push(shown.map((s) => `${esc(s.id, 60)} ×${s.counts.forever}`).join(", ") + (stats.length > shown.length ? `, … ${stats.length - shown.length} more in the JSON.` : ""));
    o.push("");
  }

  // Guide coupling
  o.push("## Guide-file coupling (category 4)");
  o.push("");
  o.push("Guide files = Lua under `Guides/` or `lang/Guides-*/`, or any file calling `RXPGuides.RegisterGuide`. \"Coupled\" = uses at least one addon global or calls through the private addon table. Entry points: identifier → files using it / occurrences.");
  o.push("");
  const allEp = new Map<string, { status: Record<Status, { files: number; calls: number }> }>();
  for (const r of inv.guideCoupling)
    for (const [ep, v] of Object.entries(r.entryPoints)) {
      const e = allEp.get(ep) ?? { status: { forever: { files: 0, calls: 0 }, other: { files: 0, calls: 0 }, library: { files: 0, calls: 0 } } };
      allEp.set(ep, e);
      e.status[r.status].files += v.files;
      e.status[r.status].calls += v.calls;
    }
  const gf = (s: Status) => inv.guideCoupling.filter((r) => r.status === s).reduce((a, r) => a + r.guideFiles, 0);
  const cf = (s: Status) => inv.guideCoupling.filter((r) => r.status === s).reduce((a, r) => a + r.coupledFiles, 0);
  o.push(`Guide files: ${n(gf("forever"))} loaded on Forever (${n(cf("forever"))} coupled), ${n(gf("other"))} not loaded on Forever (${n(cf("other"))} coupled).`);
  o.push("");
  o.push("| Entry point | Forever files | Forever occurrences | Not-Forever files | Not-Forever occurrences |");
  o.push("|---|---:|---:|---:|---:|");
  for (const [ep, e] of [...allEp].sort((a, b) => b[1].status.forever.files + b[1].status.other.files - (a[1].status.forever.files + a[1].status.other.files) || (a[0] < b[0] ? -1 : 1)))
    o.push(`| ${esc(ep)} | ${n(e.status.forever.files)} | ${n(e.status.forever.calls)} | ${n(e.status.other.files)} | ${n(e.status.other.calls)} |`);
  o.push("");
  o.push("Per folder:");
  o.push("");
  o.push("| Folder | Loaded on Forever? | Guide files | Coupled | Entry points (files/occurrences) |");
  o.push("|---|---|---:|---:|---|");
  for (const r of inv.guideCoupling)
    o.push(
      `| \`${r.folder}\` | ${r.status === "forever" ? "yes" : "no"} | ${r.guideFiles} | ${r.coupledFiles} | ${Object.entries(r.entryPoints)
        .sort((a, b) => b[1].calls - a[1].calls || (a[0] < b[0] ? -1 : 1))
        .map(([k, v]) => `\`${k}\` ${v.files}/${v.calls}`)
        .join(", ")} |`,
    );
  o.push("");

  // Per category
  o.push("## Per category");
  o.push("");
  for (const c of inv.categories) {
    const stats = idStats(inv.findings, (f) => f.category === c.id);
    o.push(`### ${c.num}. ${c.title}`);
    o.push("");
    o.push(c.note);
    o.push("");
    if (!stats.length) {
      o.push("No findings.");
      o.push("");
      continue;
    }
    o.push(`${n(stats.length)} distinct identifiers, ${n(c.occurrences.total)} occurrences. Top ${Math.min(per, stats.length)}:`);
    o.push("");
    o.push("| Identifier | Forever | Not Forever | Library | Detail | Examples |");
    o.push("|---|---:|---:|---:|---|---|");
    for (const s of stats.slice(0, per))
      o.push(`| ${esc(s.id)} | ${n(s.counts.forever)} | ${n(s.counts.other)} | ${n(s.counts.library)} | ${[...s.details].map((d) => d.replace(/\|/g, "\\|")).join("; ")} | ${s.examples.map((e) => "`" + e + "`").join(", ")} |`);
    o.push("");
  }

  o.push("## Method and blind spots");
  o.push("");
  for (const l of METHOD) o.push(l);
  o.push("");
  return o.join("\n");
}

export const METHOD = [
  "- Lua is tokenized (strings, long strings, comments, names, operators); there is no parser. Each rule reports a span; rules run in a fixed priority order (tools/inventory-ids/rules.ts) and the first rule to claim a span owns it. Any raw `RXP`/`RestedXP` occurrence left outside every claimed span is reported as category 13.",
  "- Globals: a name counts as local if it is declared `local`, is a function parameter or a `for` variable *anywhere in the same file* (scope-insensitive). A global written in one function and declared local in another function of the same file is missed. Global writes are `=` statements outside table constructors and `function Name…` declarations whose root is not such a local; reads are name tokens matching a global the addon defines anywhere (non-library files), plus any `RXP`-named token that is not local.",
  "- Not seen: globals created through `setglobal`, `rawset(_G, …)`, `loadstring`, `_G[expr]` with a computed key (reported as the expression, name unknown), frames named by a variable (reported as the expression), names built at run time (`\"RXP\" .. x`), and globals created by `CreateFrame` in libraries.",
  "- XML: attributes are read with a regex over tags (no schema); Lua inside XML script handlers is not tokenized. Bindings.xml is treated as loaded on Forever because the client reads it from the addon folder whenever the addon loads.",
  "- Load status comes from the TOC/XML manifests as resolved by tools/check-manifests (`camelot` = Forever). Runtime early-outs inside loaded files (e.g. guides that `return` for the wrong faction or locale) still count as loaded.",
  "- Commercial words are matched in string literals only; in guide files only unambiguous words (restedxp.com, discord, patreon, premium, purchase, subscribe, donate) are matched, because \"buy\"/\"upgrade\" are game instructions there.",
];
