// Pure conversion of a /wf dump (WayfinderData.dump, as JSON from
// tools/read-savedvars) into research CSVs, a README and a diff against the
// research workbook CSVs. No file I/O here; see index.ts.
//
// Diff matching rules: spells and items match the workbook by ID only (spell
// ID, item ID). Trainer data joins a spell ID only through the dump's own
// spellbook (exact name + rank text, unique; done in game by DataDump.lua).
// The zone-ids tab holds Wowhead area IDs, not UiMapIDs, so it is never
// compared as IDs: the diff lists the UiMapIDs the dump observed for each zone
// name (exact, case-insensitive name match).

import { toCsv } from "../lib/csv.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A Lua array as read-savedvars gives it: an array, or an object with numeric keys (holes). */
export function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObj(v)) {
    return Object.keys(v)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => v[k]);
  }
  return [];
}

const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Cell text: "" for nothing, JSON for tables. */
export function cell(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function tooltipText(v: unknown): string {
  return list(v)
    .map((line) => {
      const l = cell(obj(line).l);
      const r = cell(obj(line).r);
      return r ? `${l} [${r}]` : l;
    })
    .join(" | ");
}

export interface Dump {
  meta: Obj;
  [section: string]: unknown;
}

/** Find WayfinderData.dump in a read-savedvars result (or accept the dump itself). */
export function findDump(root: unknown): Dump {
  const r = obj(root);
  const candidates = [obj(r.WayfinderData).dump, r.dump, r];
  for (const c of candidates) if (isObj(c) && isObj(c.meta)) return c as Dump;
  throw new Error("no WayfinderData.dump with a meta table in the input (run /wf dump in game, then /reload)");
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_") || "unknown";

/** <YYYY-MM-DD>-<class>-<race>-L<level> from the dump meta. */
export function folderName(meta: Obj, today = new Date().toISOString().slice(0, 10)): string {
  const time = str(meta.time);
  const date = time && /^\d{4}-\d{2}-\d{2}/.test(time) ? time.slice(0, 10) : today;
  return `${date}-${safe(cell(meta.class))}-${safe(cell(meta.race))}-L${safe(cell(meta.level))}`;
}

// ---------------------------------------------------------------------------
// CSVs

function costColumns(costs: unknown): string[] {
  if (typeof costs === "string") return ["", "", "", "", "", costs];
  const rows = list(costs).map(obj);
  const first = rows[0] ?? {};
  const all = rows.map((c) => `${cell(c.name ?? c.type)}:${cell(c.cost)}`).join("; ");
  return [cell(first.type), cell(first.name), cell(first.cost), cell(first.minCost), cell(first.costPerSec), all || "none"];
}

const PRIMARY_LABELS = ["strength", "agility", "stamina", "intellect", "spirit"]; // client order of UnitStat 1..5

export function toCsvs(dump: Dump): Record<string, string> {
  const out: Record<string, string> = {};

  out["spells.csv"] = toCsv([
    ["source", "slot", "tab", "kind", "spell_id", "name", "subtext", "passive", "future", "cast_time_ms", "min_range", "max_range",
      "cost_type", "cost_name", "cost", "min_cost", "cost_per_sec", "costs", "tooltip_path", "tooltip"],
    ...list(dump.spells).map(obj).map((s) => [
      cell(s.source), cell(s.slot), cell(s.tab), cell(s.kind), cell(s.id), cell(s.name), cell(s.subtext), cell(s.passive),
      cell(s.future), cell(s.castTime), cell(s.minRange), cell(s.maxRange), ...costColumns(s.costs), cell(s.tooltipPath),
      tooltipText(s.tooltip),
    ]),
  ]);

  out["racials.csv"] = toCsv([
    ["spell_id", "name", "subtext", "passive", "tooltip"],
    ...list(dump.racials).map(obj).map((r) => [cell(r.id), cell(r.name), cell(r.subtext), cell(r.passive), tooltipText(r.tooltip)]),
  ]);

  out["talents.csv"] = toCsv([
    ["tab", "tab_name", "index", "name", "tier", "column", "rank", "max_rank", "prereqs", "raw"],
    ...list(dump.talents).map(obj).map((t) => [
      cell(t.tab), cell(t.tabName), cell(t.index), cell(t.name), cell(t.tier), cell(t.column), cell(t.rank), cell(t.maxRank),
      list(t.prereqs).map(obj).map((p) => `tier ${cell(p.tier)} col ${cell(p.column)}`).join("; "),
      cell(t.raw),
    ]),
  ]);

  const trainerRows: string[][] = [];
  for (const [key, recordValue] of Object.entries(obj(dump.trainer))) {
    const r = obj(recordValue);
    for (const sv of list(r.services)) {
      const s = obj(sv);
      trainerRows.push([
        cell(r.npcId ?? key), cell(r.uiMapID), cell(r.x), cell(r.y), cell(r.level),
        Object.entries(obj(r.filters)).map(([k, v]) => `${k}=${cell(v)}`).join(" "),
        cell(s.index), cell(s.name), cell(s.rank), cell(s.category), cell(s.levelReq), cell(s.cost),
        typeof s.cost === "number" ? formatMoney(s.cost) : "", cell(s.skillLine), cell(s.spellId), cell(s.spellIdSource),
      ]);
    }
  }
  out["trainer.csv"] = toCsv([
    ["npc_id", "ui_map_id", "x", "y", "player_level", "filters", "index", "name", "rank", "category", "level_req", "cost_copper",
      "cost", "skill_line", "spell_id", "spell_id_source"],
    ...trainerRows,
  ]);

  out["quests.csv"] = toCsv([
    ["quest_id", "title", "level", "suggested_group", "objectives", "choice_item_ids", "reward_item_ids"],
    ...list(dump.quests).map(obj).map((q) => [
      cell(q.questID), cell(q.title), cell(q.level), cell(q.suggestedGroup),
      list(q.objectives).map(obj).map((o) => `${cell(o.text)} (${cell(o.type)} ${cell(o.numRequired)})`).join(" | "),
      list(q.choices).map(obj).map((c) => cell(c.itemID)).join(" "),
      list(q.rewards).map(obj).map((c) => cell(c.itemID)).join(" "),
    ]),
  ]);

  out["items.csv"] = toCsv([
    ["source", "bag", "slot", "item_id", "name", "cached", "quality", "item_level", "required_level", "equip_slot", "item_type",
      "item_subtype", "count", "stats", "tooltip"],
    ...list(dump.items).map(obj).map((i) => [
      cell(i.source), cell(i.bag), cell(i.slot), cell(i.itemID), cell(i.name), cell(i.cached), cell(i.quality), cell(i.itemLevel),
      cell(i.requiredLevel), cell(i.equipSlot), cell(i.itemType), cell(i.itemSubType), cell(i.count),
      isObj(i.stats) ? Object.entries(i.stats).sort().map(([k, v]) => `${k}=${cell(v)}`).join("; ") : cell(i.stats),
      tooltipText(i.tooltip),
    ]),
  ]);

  const st = obj(dump.stats);
  const statRows: string[][] = [];
  list(st.primary).map(obj).forEach((p, i) => {
    const label = PRIMARY_LABELS[(num(p.index) ?? i + 1) - 1] ?? `stat${cell(p.index)}`;
    statRows.push([`${label}_base`, cell(p.base)]);
  });
  statRows.push(
    ["armor_base", cell(obj(st.armor).base)],
    ["level", cell(st.level)],
    ["equipped_slots", list(st.equippedSlots).map(cell).join(" ")],
    ["naked", cell(st.naked)],
  );
  out["stats.csv"] = toCsv([["field", "value"], ...statRows]);

  out["maps.csv"] = toCsv([
    ["ui_map_id", "map_name", "map_type", "parent_map_id", "zone_text", "subzone_text", "real_zone_text", "instance_id",
      "instance_name", "instance_type", "event", "seen", "time"],
    ...list(dump.maps).map(obj).map((m) => [
      cell(m.uiMapID), cell(m.mapName), cell(m.mapType), cell(m.parentMapID), cell(m.zoneText), cell(m.subZoneText),
      cell(m.realZoneText), cell(m.instanceID), cell(m.instanceName), cell(m.instanceType), cell(m.event), cell(m.seen), cell(m.time),
    ]),
  ]);
  return out;
}

// ---------------------------------------------------------------------------
// README

const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function readme(dump: Dump, folder: string): string {
  const m = dump.meta;
  const b = obj(m.build);
  const lines = [
    `# Game data dump ${folder}`,
    "",
    "Read from the WoW: Forever client by Wayfinder's `/wf dump` (Modules/DataDump.lua) and converted by",
    "`tools/dump-to-research`. Local research only (git-ignored). Values are what the client reported; \"secret\"",
    "means the client hid the value from addons.",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Class / race / level / faction | ${md(cell(m.class))} / ${md(cell(m.race))} / ${md(cell(m.level))} / ${md(cell(m.faction))} |`,
    `| Client build | ${md(cell(b.version))} build ${md(cell(b.build))} (${md(cell(b.date))}), interface ${md(cell(m.interface))} |`,
    `| Locale | ${md(cell(m.locale))} |`,
    `| Dumped at | ${md(cell(m.time))} |`,
    `| Addon version | ${md(cell(m.addonVersion))} |`,
    `| Full dump completed | ${md(cell(m.complete))} |`,
    `| Development seeds | ${isObj(m.seeds) ? `${cell(m.seeds.items)} items, ${cell(m.seeds.spells)} spells` : "none"} |`,
    "",
    "## Sections",
    "",
    "| Section | Status | Count | Capped | Seconds | API path | Notes |",
    "|---|---|---|---|---|---|---|",
  ];
  const sections = obj(m.sections);
  const order = ["stats", "spells", "racials", "talents", "quests", "items", "trainer", "maps"];
  for (const name of [...order, ...Object.keys(sections).filter((k) => !order.includes(k)).sort()]) {
    const s = obj(sections[name]);
    if (!isObj(sections[name])) {
      lines.push(`| ${name} | not dumped | | | | | |`);
      continue;
    }
    const notes = Object.entries(s)
      .filter(([k]) => !["status", "count", "capped", "seconds", "path"].includes(k))
      .map(([k, v]) => `${k}: ${cell(v)}`)
      .join("; ");
    lines.push(`| ${name} | ${md(cell(s.status))} | ${md(cell(s.count))} | ${s.capped ? "yes" : ""} | ${md(cell(s.seconds))} | ${md(cell(s.path))} | ${md(notes)} |`);
  }
  lines.push("", "Files: spells.csv, racials.csv, talents.csv, trainer.csv, quests.csv, items.csv, stats.csv, maps.csv; diff.md when the research CSVs are present.", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Diff against the workbook CSVs

/** "1g80s", "60s", "10c", "2g" -> copper; undefined when no amount is found. */
export function parseMoney(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (!/\d\s*[gsc](?![a-z])/.test(t)) return undefined;
  const part = (unit: string) => Number(t.match(new RegExp(`(\\d+)\\s*${unit}(?![a-z])`))?.[1] ?? 0);
  return part("g") * 10000 + part("s") * 100 + part("c");
}

export function formatMoney(copper: number): string {
  const g = Math.floor(copper / 10000);
  const s = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  return [g ? `${g}g` : "", s ? `${s}s` : "", c || (!g && !s) ? `${c}c` : ""].join("");
}

export interface Disagreement {
  tab: string;
  row: string;
  id: number;
  field: string;
  workbook: string;
  game: string;
}

export interface ZoneObservation {
  row: string;
  zone: string;
  areaId: string;
  uiMapIds: number[];
  details: string;
}

export interface DiffResult {
  rows: Disagreement[];
  zones: ZoneObservation[];
  summary: { tab: string; ids: number; seen: number; disagreements: number }[];
  notes: string[];
}

const norm = (s: string) => s.trim().replace(/[‘’]/g, "'").replace(/\s+/g, " ").toLowerCase();
const intOf = (s: string | undefined) => (s && /^\s*\d+\s*$/.test(s) ? Number(s) : undefined);
const QUALITY = ["Poor", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Artifact", "Heirloom"];
const STAT_NAMES = ["Strength", "Agility", "Stamina", "Intellect", "Spirit"];

/** Header-indexed access to a CSV table. */
function table(rows: string[][] | undefined): { get: (r: string[], col: string) => string | undefined; body: string[][] } | undefined {
  if (!rows || rows.length === 0) return undefined;
  const header = rows[0]!.map((h) => norm(h));
  return {
    get: (r, col) => {
      const i = header.indexOf(norm(col));
      return i < 0 ? undefined : r[i];
    },
    body: rows.slice(1),
  };
}

interface GameSpell {
  name?: string;
  rank?: number;
}
interface GameTrainer {
  levelReq?: number;
  cost?: number;
}

function gameIndexes(dump: Dump) {
  const spells = new Map<number, GameSpell>();
  for (const sv of [...list(dump.spells), ...list(dump.racials)]) {
    const s = obj(sv);
    const id = num(s.id);
    if (id === undefined || spells.has(id)) continue;
    const name = str(s.name);
    if (name === undefined || name === "secret") continue;
    const sub = str(s.subtext);
    const rank = sub && sub !== "secret" ? Number(sub.match(/(\d+)/)?.[1]) : NaN;
    spells.set(id, { name, rank: Number.isFinite(rank) ? rank : undefined });
  }
  const trainer = new Map<number, GameTrainer>();
  for (const recordValue of Object.values(obj(dump.trainer))) {
    for (const sv of list(obj(recordValue).services)) {
      const s = obj(sv);
      const id = num(s.spellId);
      if (id === undefined || trainer.has(id)) continue;
      trainer.set(id, { levelReq: num(s.levelReq), cost: num(s.cost) });
    }
  }
  const items = new Map<number, Obj>();
  for (const iv of list(dump.items)) {
    const i = obj(iv);
    const id = num(i.itemID);
    if (id === undefined || i.cached === false || str(i.name) === undefined) continue;
    if (!items.has(id)) items.set(id, i);
  }
  return { spells, trainer, items };
}

function statFromGame(stats: Obj, name: string): number | undefined {
  const key = Object.keys(stats).find((k) => new RegExp(`^ITEM_MOD_${name.toUpperCase()}(_SHORT)?$`).test(k));
  return key ? num(stats[key]) : undefined;
}

export function buildDiff(dump: Dump, tabs: Record<string, string[][]>): DiffResult {
  const result: DiffResult = { rows: [], zones: [], summary: [], notes: [] };
  const game = gameIndexes(dump);

  const push = (tab: string, row: string, id: number, field: string, workbook: string | number | undefined, gameValue: string | number | undefined) => {
    if (workbook === undefined || workbook === "" || gameValue === undefined || gameValue === "") return;
    const differ = typeof workbook === "number" || typeof gameValue === "number" ? String(workbook) !== String(gameValue) : norm(workbook) !== norm(gameValue);
    if (differ) result.rows.push({ tab, row, id, field, workbook: String(workbook), game: String(gameValue) });
  };

  // One spell (ID, plus optional rank, learn level, cost from the workbook) against the game.
  const compareSpell = (tab: string, row: string, id: number, name: string | undefined, rank: number | undefined, level: number | undefined, cost: string | undefined, label: string) => {
    const s = game.spells.get(id);
    const t = game.trainer.get(id);
    if (!s && !t) return false;
    if (s) {
      push(tab, row, id, `${label}name`, name, s.name);
      push(tab, row, id, `${label}rank`, rank, s.rank);
    }
    if (t) {
      push(tab, row, id, `${label}learn level`, level, t.levelReq);
      const copper = cost ? parseMoney(cost) : undefined;
      if (copper !== undefined && t.cost !== undefined && copper !== t.cost) {
        result.rows.push({ tab, row, id, field: `${label}trainer cost`, workbook: `${cost} (${copper})`, game: `${formatMoney(t.cost)} (${t.cost})` });
      }
    }
    return true;
  };

  const count = (tab: string, before: number, ids: number, seen: number) =>
    result.summary.push({ tab, ids, seen, disagreements: result.rows.length - before });

  const spellIds = table(tabs["spell-ids"]);
  if (spellIds) {
    const before = result.rows.length;
    let ids = 0;
    let seen = 0;
    for (const r of spellIds.body) {
      const id = intOf(spellIds.get(r, "Spell ID"));
      if (id === undefined) continue;
      ids++;
      const found = compareSpell("spell-ids", spellIds.get(r, "row") ?? "", id, spellIds.get(r, "Ability"), intOf(spellIds.get(r, "Rank")),
        intOf(spellIds.get(r, "Learn level")), spellIds.get(r, "Trainer cost"), "");
      if (found) seen++;
    }
    count("spell-ids", before, ids, seen);
  }

  const classAbilities = table(tabs["class-abilities"]);
  if (classAbilities) {
    const before = result.rows.length;
    let ids = 0;
    let seen = 0;
    const split = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim());
    for (const r of classAbilities.body) {
      const idList = split(classAbilities.get(r, "Spell IDs (by rank)"));
      const levels = split(classAbilities.get(r, "Learn levels (by rank)"));
      const costs = split(classAbilities.get(r, "Trainer costs (by rank)"));
      idList.forEach((idText, i) => {
        const id = intOf(idText);
        if (id === undefined) return;
        ids++;
        const rank = idList.length > 1 ? i + 1 : undefined;
        const found = compareSpell("class-abilities", classAbilities.get(r, "row") ?? "", id, classAbilities.get(r, "Ability"), rank,
          intOf(levels[i]), costs[i], idList.length > 1 ? `rank ${i + 1} ` : "");
        if (found) seen++;
      });
    }
    count("class-abilities", before, ids, seen);
  }

  for (const tab of ["quest-rewards", "dungeon-loot"]) {
    const t = table(tabs[tab]);
    if (!t) continue;
    const before = result.rows.length;
    let ids = 0;
    let seen = 0;
    for (const r of t.body) {
      const id = intOf(t.get(r, "Item ID"));
      if (id === undefined) continue;
      ids++;
      const item = game.items.get(id);
      if (!item) continue;
      seen++;
      const row = t.get(r, "row") ?? "";
      push(tab, row, id, "name", t.get(r, "Item"), str(item.name));
      const q = num(item.quality);
      push(tab, row, id, "quality", t.get(r, "Quality"), q === undefined ? undefined : (QUALITY[q] ?? String(q)));
      push(tab, row, id, "item level", intOf(t.get(r, "Item level")), num(item.itemLevel));
      push(tab, row, id, "required level", intOf(t.get(r, "Required level")), num(item.requiredLevel));
      const statsText = t.get(r, "Stats");
      if (statsText !== undefined && isObj(item.stats)) {
        for (const stat of STAT_NAMES) {
          const wb = Number(statsText.match(new RegExp(`\\+(\\d+)\\s+${stat}\\b`, "i"))?.[1] ?? 0);
          const gm = statFromGame(item.stats, stat) ?? 0;
          if (wb !== gm) result.rows.push({ tab, row, id, field: `stat ${stat}`, workbook: String(wb), game: String(gm) });
        }
        const wbArmor = statsText.match(/(\d+)\s+armor\b/i)?.[1];
        const gmArmor = num(item.stats.RESISTANCE0_NAME);
        if (wbArmor !== undefined && gmArmor !== undefined) push(tab, row, id, "armor", Number(wbArmor), gmArmor);
      }
    }
    count(tab, before, ids, seen);
  }

  const zones = table(tabs["zone-ids"]);
  if (zones) {
    const maps = list(dump.maps).map(obj);
    for (const r of zones.body) {
      const zone = zones.get(r, "Zone") ?? "";
      if (!zone.trim()) continue;
      const hits = maps.filter((m) => [str(m.mapName), str(m.zoneText)].some((v) => v !== undefined && norm(v) === norm(zone)));
      const ids = [...new Set(hits.map((m) => num(m.uiMapID)).filter((v): v is number => v !== undefined))].sort((a, b) => a - b);
      result.zones.push({
        row: zones.get(r, "row") ?? "",
        zone,
        areaId: zones.get(r, "Zone ID") ?? "",
        uiMapIds: ids,
        details: hits.map((m) => `${cell(m.uiMapID)} ${cell(m.mapName)} (type ${cell(m.mapType)}, parent ${cell(m.parentMapID)})`).filter((v, i, a) => a.indexOf(v) === i).join("; "),
      });
    }
  }

  if (tabs["trainers"]) result.notes.push("trainers: the tab names trainers and places but has no spell or NPC IDs, so it is not compared; trainer.csv lists the creature ID, UiMapID and position of each trainer the dump saw.");
  for (const tab of ["spell-ids", "class-abilities", "quest-rewards", "dungeon-loot", "zone-ids"]) {
    if (!tabs[tab]) result.notes.push(`${tab}: research CSV not found; not compared.`);
  }
  return result;
}

export function diffMarkdown(diff: DiffResult, folder: string): string {
  const lines = [
    `# Dump ${folder} vs research workbook`,
    "",
    "Disagreements between what the client reported and the research CSVs (docs/research/csv). Matching is by",
    "ID only (spell ID, item ID); a trainer service has a spell ID only when the dump's spellbook had exactly one",
    "spell with its name and rank. Text compares ignore case and spacing. The game wins: fix the workbook, note the date.",
    "",
    "| Tab | IDs on tab | Seen in dump | Disagreements |",
    "|---|---|---|---|",
    ...diff.summary.map((s) => `| ${s.tab} | ${s.ids} | ${s.seen} | ${s.disagreements} |`),
    "",
    "## Disagreements",
    "",
  ];
  if (diff.rows.length === 0) lines.push("None.");
  else {
    lines.push("| Tab | Row | ID | Field | Workbook | Game |", "|---|---|---|---|---|---|");
    for (const d of diff.rows) lines.push(`| ${d.tab} | ${md(d.row)} | ${d.id} | ${md(d.field)} | ${md(d.workbook)} | ${md(d.game)} |`);
  }
  lines.push(
    "",
    "## UiMapIDs observed for zone-ids rows",
    "",
    "The zone-ids tab holds Wowhead area IDs, not UiMapIDs; they are never compared. Matched by exact zone name",
    "(map name or zone text, ignoring case).",
    "",
  );
  if (diff.zones.length === 0) lines.push("No zone-ids rows.");
  else {
    lines.push("| Row | Zone | Area ID (workbook) | UiMapIDs seen | Maps |", "|---|---|---|---|---|");
    for (const z of diff.zones) lines.push(`| ${md(z.row)} | ${md(z.zone)} | ${md(z.areaId)} | ${z.uiMapIds.join(", ") || "not visited"} | ${md(z.details)} |`);
  }
  if (diff.notes.length) lines.push("", "## Notes", "", ...diff.notes.map((n) => `- ${n}`));
  lines.push("");
  return lines.join("\n");
}
