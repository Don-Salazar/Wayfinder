// analyze-log core: turn field logs (WayfinderCharData.log, written by
// Modules/FieldLog.lua) into the fixed-section report of docs/FIELD_LOG.md
// section 4. Pure functions only; index.ts does the file I/O.
//
// Matching rules:
//   * Events are ordered by linearising the ring buffer (head, count, cap);
//     a damaged ring falls back to sorting by the sequence number `n`.
//   * A session is a `session` event plus every event after it up to the
//     next one. Events before the first session event form session 0.
//   * "Not in the guide" means g === false on quest_accept / quest_turnin;
//     g missing (no active guide) is counted separately, never guessed.
//   * Research reconciliation compares by exact quest ID only (the "Quest ID"
//     column of the quest tabs); names are never matched, fuzzy or otherwise.
//   * A finding has a stable key; keys found in the previous report for the
//     same install ID are listed first and marked "again".

import { basename } from "node:path";
import { parseCsv } from "../lib/csv.ts";

export type Obj = Record<string, unknown>;

export interface LogEvent extends Obj {
  n: number;
  k: string;
  t?: number;
}

export interface CharacterLog {
  source: string;
  installId: string;
  log: Obj;
  events: LogEvent[];
}

export interface Session {
  index: number; // s field, or 0 for events before any session event
  label: string; // character label: class, race, name if recorded
  date?: string;
  header?: LogEvent;
  events: LogEvent[];
}

export interface ResearchRow {
  tab: string;
  row: string;
  questId: number;
  title: string;
  xp?: number;
}

export interface PreviousSummary {
  file: string;
  findings: Set<string>;
}

export interface ReportInput {
  installId: string;
  logs: CharacterLog[];
  selftest?: Obj;
  research?: ResearchRow[]; // undefined: no research CSVs found
  previous?: PreviousSummary;
}

export const NO_DATA = "_No data at this stage: needs step events (FIELD_LOG section 3), not built yet._";
export const SUMMARY_MARK = "analyze-log:summary";
export const QUEST_TABS = ["riverglades-quests", "shendralas-quests"];

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A Lua array as parsed by read-savedvars: an array, or an object with numeric keys. */
export function luaArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (!isObj(v)) return [];
  return Object.keys(v)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => v[k]);
}

function isEvent(v: unknown): v is LogEvent {
  return isObj(v) && typeof v.n === "number" && typeof v.k === "string";
}

/** The events of a saved log, oldest first. */
export function linearize(log: Obj): LogEvent[] {
  const events = luaArray(log.events);
  const cap = num(log.cap);
  const head = num(log.head);
  const count = num(log.count);
  const valid =
    cap !== undefined && head !== undefined && count !== undefined &&
    Number.isInteger(cap) && Number.isInteger(head) && Number.isInteger(count) &&
    count === events.length && count <= cap && head >= 1 && head <= cap &&
    (count === cap || head === 1) && events.every(isEvent);
  if (valid) {
    const out: LogEvent[] = [];
    for (let i = 0; i < count; i++) out.push(events[(head - 1 + i) % count] as LogEvent);
    return out;
  }
  return events.filter(isEvent).sort((a, b) => a.n - b.n);
}

/** Every field log and the self-test report in parsed SavedVariables data. */
export function findLogs(data: unknown, source: string): { logs: CharacterLog[]; selftest?: Obj } {
  const out: { logs: CharacterLog[]; selftest?: Obj } = { logs: [] };
  if (!isObj(data)) return out;
  const charData = data.WayfinderCharData;
  if (isObj(charData) && isObj(charData.log)) {
    const log = charData.log;
    const events = linearize(log);
    const installId = str(log.id) ?? str(events.find((e) => e.k === "session")?.id) ?? "unknown";
    out.logs.push({ source, installId, log, events });
  }
  const accountData = data.WayfinderData;
  if (isObj(accountData) && isObj(accountData.selftest)) out.selftest = accountData.selftest;
  return out;
}

function characterLabel(header: LogEvent | undefined): string {
  if (!header) return "unknown character";
  const parts = [str(header.r), str(header.cl)].filter((p): p is string => !!p);
  // pn / pr: the player name and realm, present only when the player opted in.
  const name = str(header.pn);
  const realm = str(header.pr);
  if (name) parts.push(realm ? `${name}-${realm}` : name);
  return parts.length ? parts.join(" ") : "unknown character";
}

/** Split events into sessions at each `session` event. */
export function splitSessions(events: LogEvent[]): Session[] {
  const sessions: Session[] = [];
  let current: Session | undefined;
  for (const event of events) {
    if (event.k === "session") {
      current = {
        index: num(event.s) ?? 0,
        label: characterLabel(event),
        date: str(event.d),
        header: event,
        events: [event],
      };
      sessions.push(current);
    } else {
      if (!current) {
        current = { index: 0, label: "unknown character", events: [] };
        sessions.push(current);
      }
      current.events.push(event);
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Research CSVs

const toInt = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const cleaned = text.replace(/[,\s]/g, "");
  return /^\d+$/.test(cleaned) ? Number(cleaned) : undefined;
};

/** Quest rows of one research tab (columns row, Quest ID, Quest, XP). */
export function questRows(tab: string, csvText: string): ResearchRow[] {
  const rows = parseCsv(csvText);
  const header = rows[0] ?? [];
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const rowCol = col("row");
  const idCol = col("Quest ID");
  const titleCol = col("Quest");
  const xpCol = col("XP");
  if (idCol < 0) return [];
  const out: ResearchRow[] = [];
  for (const row of rows.slice(1)) {
    const questId = toInt(row[idCol]);
    if (questId === undefined) continue;
    out.push({
      tab,
      row: rowCol >= 0 ? (row[rowCol] ?? "") : "",
      questId,
      title: titleCol >= 0 ? (row[titleCol] ?? "") : "",
      xp: xpCol >= 0 ? toInt(row[xpCol]) : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Previous report

/** The machine-readable summary embedded at the end of a report, or undefined. */
export function readSummary(markdown: string): { installId?: string; findings: string[] } | undefined {
  const match = markdown.match(new RegExp(`<!-- ${SUMMARY_MARK} (\\{.*\\}) -->`));
  if (!match?.[1]) return undefined;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!isObj(parsed)) return undefined;
    const findings = Array.isArray(parsed.findings) ? parsed.findings.filter((f): f is string => typeof f === "string") : [];
    return { installId: str(parsed.installId), findings };
  } catch {
    return undefined;
  }
}

/** Report file names for an install id, e.g. 2026-11-18-0a1b2c3d4e5f.md. */
export function reportName(date: string, installId: string): string {
  return `${date}-${installId}.md`;
}

/** The most recent report for installId named before `current` (by name, which sorts by date). */
export function previousReportName(names: string[], installId: string, current: string): string | undefined {
  const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${installId.replace(/[^\w-]/g, "")}\\.md$`);
  return names.filter((n) => pattern.test(n) && n < current).sort().at(-1);
}

// ---------------------------------------------------------------------------
// Report

interface Finding {
  key: string;
  again: boolean;
  cells: string[];
}

const esc = (text: string): string => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const firstLine = (text: string, max = 160): string => {
  const line = text.split(/\r?\n/)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const evRef = (events: LogEvent[], max = 6): string => {
  const refs = events.slice(0, max).map((e) => `#${e.n}`);
  if (events.length > max) refs.push(`+${events.length - max}`);
  return refs.join(" ");
};
const where = (session: Session, event: LogEvent): string => `s${session.index} t=${fmt(num(event.t) ?? 0)}s`;

function table(header: string[], findings: Finding[], empty: string): string[] {
  if (!findings.length) return [empty, ""];
  const sorted = [...findings].sort((a, b) => Number(b.again) - Number(a.again) || a.key.localeCompare(b.key));
  return [
    `| Again | ${header.join(" | ")} |`,
    `|---|${header.map(() => "---").join("|")}|`,
    ...sorted.map((f) => `| ${f.again ? "**again**" : ""} | ${f.cells.map(esc).join(" | ")} |`),
    "",
  ];
}

interface Located {
  session: Session;
  event: LogEvent;
}

function eventsOf(sessions: Session[], kind: string): Located[] {
  const out: Located[] = [];
  for (const session of sessions) {
    for (const event of session.events) if (event.k === kind) out.push({ session, event });
  }
  return out;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

interface PaceRow {
  session: Session;
  seconds: number;
  quest: number;
  other: number;
}

interface LevelPace {
  seconds: number;
  quest: number;
  other: number;
}

/** XP and time per session and per level (time at a level runs between level events). */
function pace(sessions: Session[]): { rows: PaceRow[]; levels: Map<number, LevelPace> } {
  const rows: PaceRow[] = [];
  const levels = new Map<number, LevelPace>();
  const at = (lv: number): LevelPace => {
    let entry = levels.get(lv);
    if (!entry) {
      entry = { seconds: 0, quest: 0, other: 0 };
      levels.set(lv, entry);
    }
    return entry;
  };
  for (const session of sessions) {
    const row: PaceRow = { session, seconds: 0, quest: 0, other: 0 };
    let level = num(session.header?.lv);
    let since = 0;
    let last = 0;
    for (const event of session.events) {
      const t = num(event.t) ?? last;
      last = Math.max(last, t);
      if (event.k === "xp") {
        const amount = num(event.a) ?? 0;
        const source = event.src === "quest" ? "quest" : "other";
        row[source] += amount;
        const lv = num(event.lv) ?? level;
        if (lv !== undefined) at(lv)[source] += amount;
      } else if (event.k === "level") {
        const next = num(event.nl);
        if (level !== undefined) at(level).seconds += Math.max(0, t - since);
        since = t;
        if (next !== undefined) level = next;
      }
    }
    if (level !== undefined) at(level).seconds += Math.max(0, last - since);
    row.seconds = last;
    rows.push(row);
  }
  return { rows, levels: new Map([...levels.entries()].sort(([a], [b]) => a - b)) };
}

const perHour = (xp: number, seconds: number): string => (seconds > 0 ? fmt(Math.round((xp * 3600) / seconds)) : "-");
const duration = (seconds: number): string => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};

export interface Report {
  name: string;
  date: string;
  markdown: string;
  patch: string;
  findings: string[];
}

/** Report date: the newest session date (YYYY-MM-DD), or "undated". */
export function reportDate(logs: CharacterLog[]): string {
  const dates: string[] = [];
  for (const log of logs) {
    for (const e of log.events) {
      const d = e.k === "session" ? str(e.d) : undefined;
      if (d && /^\d{4}-\d{2}-\d{2}/.test(d)) dates.push(d.slice(0, 10));
    }
  }
  return dates.sort().at(-1) ?? "undated";
}

export function buildReport(input: ReportInput): Report {
  const { installId, logs } = input;
  const date = reportDate(logs);
  const name = reportName(date, installId);
  const seenBefore = input.previous?.findings ?? new Set<string>();
  const allFindings: string[] = [];
  const finding = (key: string, cells: string[]): Finding => {
    allFindings.push(key);
    return { key, again: seenBefore.has(key), cells };
  };

  const sessions = logs.flatMap((l) => splitSessions(l.events));
  const totalEvents = logs.reduce((n, l) => n + l.events.length, 0);
  const dropped = logs.reduce((n, l) => n + (num(l.log.dropped) ?? 0), 0);
  const out: string[] = [];

  out.push(`# Field log report: ${date}, install ${installId}`, "");
  out.push("Generated by `tools/analyze-log` from:");
  // File names only: a full path would put the local user name into a committed report.
  for (const log of logs) out.push(`- \`${basename(log.source)}\` (${log.events.length} events, cap ${num(log.log.cap) ?? "?"})`);
  out.push("");
  out.push(`Sessions: ${sessions.length}. Events: ${totalEvents}. Dropped by the ring buffer: ${dropped}.`);
  if (input.previous) out.push(`Compared with the previous report \`${input.previous.file}\`; findings seen there are marked **again** and listed first.`);
  else out.push("No earlier report for this install ID: nothing is marked **again**.");
  out.push("Event references (#n) are the log's sequence numbers; `s<n>` is the session number.", "");

  if (sessions.length) {
    out.push("| Session | Date | Character | Level | Addon | Client | Guide | Events |", "|---|---|---|---|---|---|---|---|");
    for (const s of sessions) {
      const h = s.header;
      const gd = isObj(h?.gd) ? h.gd : undefined;
      const guide = gd ? `${str(gd.name) ?? "?"} v${num(gd.version) ?? "?"}` : "none recorded";
      out.push(`| ${s.index} | ${s.date ?? "?"} | ${esc(s.label)} | ${num(h?.lv) ?? "?"} | ${str(h?.av) ?? "?"} | ${str(h?.cv) ?? "?"} ${str(h?.b) ?? ""} | ${esc(guide)} | ${s.events.length} |`);
    }
    out.push("");
  }

  // 1. Errors and blocked actions --------------------------------------------
  out.push("## 1. Errors and blocked actions", "");
  const errors = groupBy(eventsOf(sessions, "error"), ({ event }) => `${str(event.mod) ?? "?"}\u0000${firstLine(str(event.msg) ?? "")}`);
  const errorFindings: Finding[] = [];
  for (const [key, items] of errors) {
    const [mod, message] = key.split("\u0000") as [string, string];
    const count = items.reduce((n, { event }) => n + (num(event.c) ?? 1), 0);
    const first = items[0]!;
    const last = items.at(-1)!;
    errorFindings.push(finding(`error:${mod}:${message}`, [mod, message, String(count), where(first.session, first.event),
      where(last.session, last.event), evRef(items.map((i) => i.event))]));
  }
  out.push("### Lua errors", "");
  out.push(...table(["Module", "Message", "Count", "First", "Last", "Events"], errorFindings, "None."));
  const blocked = groupBy(eventsOf(sessions, "blocked"), ({ event }) => `${str(event.ev) ?? "blocked"}\u0000${str(event.fn) ?? "?"}`);
  const blockedFindings: Finding[] = [];
  for (const [key, items] of blocked) {
    const [ev, fn] = key.split("\u0000") as [string, string];
    const count = items.reduce((n, { event }) => n + (num(event.c) ?? 1), 0);
    const first = items[0]!;
    const last = items.at(-1)!;
    blockedFindings.push(finding(`blocked:${ev}:${fn}`, [ev, fn, String(count), where(first.session, first.event),
      where(last.session, last.event), evRef(items.map((i) => i.event))]));
  }
  out.push("### Blocked and forbidden actions", "");
  out.push(...table(["Kind", "Function", "Count", "First", "Last", "Events"], blockedFindings, "None."));
  out.push("### Probes not passing", "");
  const probes = eventsOf(sessions, "probe").filter(({ event }) => event.id !== "selftest" && event.st !== "pass");
  const probeFindings = [...groupBy(probes, ({ event }) => `${str(event.id) ?? "?"}\u0000${str(event.st) ?? "?"}`)].map(
    ([key, items]) => {
      const [id, st] = key.split("\u0000") as [string, string];
      return finding(`probe:${id}:${st}`, [id, st, firstLine(str(items.at(-1)!.event.dt) ?? "", 120), evRef(items.map((i) => i.event))]);
    },
  );
  out.push(...table(["Probe", "Status", "Detail", "Events"], probeFindings, "None in the log."));
  if (input.selftest) {
    const counts = isObj(input.selftest.counts) ? input.selftest.counts : {};
    const parts = ["pass", "fail", "missing", "skipped", "info"].map((k) => `${num(counts[k]) ?? 0} ${k}`);
    out.push(`Saved self-test report (WayfinderData.selftest): status ${str(input.selftest.status) ?? "?"}, ${parts.join(", ")}.`, "");
  }
  out.push("Active step at the time of each error: " + NO_DATA, "");

  // 2. Guide data corrections ----------------------------------------------------
  out.push("## 2. Guide data corrections", "");
  out.push("### Coordinate drift", "", NO_DATA, "");
  out.push("### Quests never offered", "", NO_DATA, "");
  out.push("### Quests the guide does not contain", "");
  const accepts = eventsOf(sessions, "quest_accept");
  const turnins = eventsOf(sessions, "quest_turnin");
  const notInGuide = groupBy([...accepts, ...turnins].filter(({ event }) => event.g === false), ({ event }) => String(num(event.q) ?? "?"));
  const missingFindings: Finding[] = [];
  for (const [quest, items] of notInGuide) {
    const accepted = items.filter((i) => i.event.k === "quest_accept");
    const turned = items.filter((i) => i.event.k === "quest_turnin");
    const giverEvent = accepted.find((i) => num(i.event.c) !== undefined || num(i.event.o) !== undefined)?.event;
    const giver = giverEvent
      ? `${num(giverEvent.c) !== undefined ? `NPC ${num(giverEvent.c)}` : `object ${num(giverEvent.o)}`}${str(giverEvent.nm) ? ` (${str(giverEvent.nm)})` : ""}`
      : "";
    const levels = [...new Set(items.map((i) => num(i.event.lv)).filter((v): v is number => v !== undefined))].sort((a, b) => a - b);
    missingFindings.push(finding(`notInGuide:${quest}`, [quest, String(accepted.length), String(turned.length), giver,
      levels.join(", "), evRef(items.map((i) => i.event))]));
  }
  out.push(...table(["Quest", "Accepted", "Turned in", "Giver", "Level", "Events"], missingFindings, "None."));
  const unknown = [...accepts, ...turnins].filter(({ event }) => event.g === undefined || event.g === null).length;
  if (unknown) out.push(`${unknown} quest event(s) happened with no active guide (g not recorded); they are not judged.`, "");

  out.push("### Quest XP observed", "");
  const xpByQuest = groupBy(turnins.filter(({ event }) => num(event.xp) !== undefined), ({ event }) => String(num(event.q)));
  const xpRows: { quest: number; values: number[]; levels: number[]; events: LogEvent[] }[] = [];
  for (const [quest, items] of xpByQuest) {
    xpRows.push({
      quest: Number(quest),
      values: items.map((i) => num(i.event.xp)!),
      levels: items.map((i) => num(i.event.lv)).filter((v): v is number => v !== undefined),
      events: items.map((i) => i.event),
    });
  }
  xpRows.sort((a, b) => a.quest - b.quest);
  if (!xpRows.length) out.push("None.", "");
  else {
    out.push("| Quest | Turn-ins | Min XP | Max XP | Player level | Events |", "|---|---|---|---|---|---|");
    for (const r of xpRows) {
      const levels = [...new Set(r.levels)].sort((a, b) => a - b).join(", ");
      out.push(`| ${r.quest} | ${r.values.length} | ${Math.min(...r.values)} | ${Math.max(...r.values)} | ${levels} | ${evRef(r.events)} |`);
    }
    out.push("");
  }
  out.push("Quest XP against the workbook: see section 5.", "");
  out.push("### Steps that needed a manual tick or a skip", "", NO_DATA, "");
  out.push("### Player notes", "");
  const notes = eventsOf(sessions, "note");
  if (!notes.length) out.push("None.", "");
  else {
    out.push("| Event | Where | Level | Map | Note |", "|---|---|---|---|---|");
    for (const { session, event } of notes) {
      const pos = num(event.x) !== undefined ? ` ${fmt(num(event.x)!)}, ${fmt(num(event.y) ?? 0)}` : "";
      out.push(`| #${event.n} | ${where(session, event)} | ${num(event.lv) ?? "?"} | ${num(event.m) ?? "?"}${pos} | ${esc(str(event.tx) ?? "")} |`);
    }
    out.push("");
  }

  // 3. Pace --------------------------------------------------------------------------
  out.push("## 3. Pace", "");
  const { rows, levels } = pace(sessions);
  out.push("### XP per hour by session", "");
  if (!rows.length) out.push("None.", "");
  else {
    out.push("| Session | Date | Time logged | Quest XP | Other XP | Total XP | XP/hour |", "|---|---|---|---|---|---|---|");
    for (const r of rows) {
      const total = r.quest + r.other;
      out.push(`| ${r.session.index} | ${r.session.date ?? "?"} | ${duration(r.seconds)} | ${r.quest} | ${r.other} | ${total} | ${perHour(total, r.seconds)} |`);
    }
    out.push("");
  }
  out.push("### XP per hour by level", "");
  if (![...levels.values()].some((l) => l.quest + l.other > 0)) out.push("None.", "");
  else {
    out.push("| Level | Time at level (logged) | Quest XP | Other XP | XP/hour |", "|---|---|---|---|---|");
    for (const [lv, l] of levels) {
      out.push(`| ${lv} | ${duration(l.seconds)} | ${l.quest} | ${l.other} | ${perHour(l.quest + l.other, l.seconds)} |`);
    }
    out.push("");
  }
  out.push("Sources are only `quest` (XP within 0.5 s of a turn-in, before or after it) and `other`; kill and exploration XP are not told apart (no chat or combat parsing).", "");
  const approximate = eventsOf(sessions, "xp").filter(({ event }) => event.ap === true);
  if (approximate.length) out.push(`${approximate.length} xp event(s) span more than one level and are approximate: ${evRef(approximate.map((a) => a.event))}.`, "");
  out.push("### Level timeline", "");
  const levelEvents = eventsOf(sessions, "level");
  if (!levelEvents.length) out.push("None.", "");
  else {
    out.push("| Level reached | Session | Time | /played | Event |", "|---|---|---|---|---|");
    for (const { session, event } of levelEvents) {
      const played = num(event.pl);
      out.push(`| ${num(event.nl) ?? "?"} | ${session.index} | t=${fmt(num(event.t) ?? 0)}s | ${played !== undefined ? duration(played) : "-"} | #${event.n} |`);
    }
    out.push("");
  }
  out.push("Planned level bands: not compared yet (no plan data in the repo).", "");
  out.push("### Slowest steps, travel time, deaths", "", NO_DATA, "");

  // 4. Choices -------------------------------------------------------------------------
  out.push("## 4. Choices", "", NO_DATA, "");

  // 5. Research reconciliation ---------------------------------------------------------
  out.push("## 5. Research reconciliation", "");
  if (!xpRows.length) out.push("No quest XP observed.", "");
  else if (!input.research) out.push(`No research quest tabs found (${QUEST_TABS.map((t) => `${t}.csv`).join(", ")}); observed XP is listed in section 2.`, "");
  else {
    const byId = new Map<number, ResearchRow[]>();
    for (const row of input.research) byId.set(row.questId, [...(byId.get(row.questId) ?? []), row]);
    const agree: string[] = [];
    const disagree: Finding[] = [];
    const absent: number[] = [];
    for (const r of xpRows) {
      const research = byId.get(r.quest);
      if (!research) {
        absent.push(r.quest);
        continue;
      }
      const observed = [...new Set(r.values)].sort((a, b) => a - b);
      for (const row of research) {
        const same = row.xp !== undefined && observed.length === 1 && observed[0] === row.xp;
        const ref = `${row.tab} row ${row.row}`;
        if (same) agree.push(`| ${r.quest} | ${esc(row.title)} | ${ref} | ${row.xp} | ${evRef(r.events)} |`);
        else
          disagree.push(finding(`xpMismatch:${r.quest}:${row.tab}:${row.row}`, [String(r.quest), row.title, ref,
            row.xp === undefined ? "(blank)" : String(row.xp), observed.join(", "), [...new Set(r.levels)].join(", "), evRef(r.events)]));
      }
    }
    out.push("### Agree (ready to mark \"Confirmed in game\")", "");
    if (!agree.length) out.push("None.", "");
    else out.push("| Quest | Title | Workbook | XP | Events |", "|---|---|---|---|---|", ...agree, "");
    out.push("### Disagree", "");
    out.push(...table(["Quest", "Title", "Workbook", "Workbook XP", "Observed XP", "Player level", "Events"], disagree, "None."));
    out.push("Observed XP can be lower than the workbook when the quest is far below the player's level; check the level column before changing a row.", "");
    if (absent.length) out.push(`Turned in but not in the quest tabs: ${absent.join(", ")}.`, "");
  }

  const findings = [...new Set(allFindings)].sort();
  out.push(`<!-- ${SUMMARY_MARK} ${JSON.stringify({ v: 1, installId, date, findings })} -->`, "");

  const patch = [
    `# Proposed guide edits: ${date}, install ${installId}`,
    "",
    `Companion to \`${name}\`.`,
    "",
    "None at this stage. Guide edits are proposed from step events (coordinate drift, quests never offered, manual ticks and skips), which the field log does not record yet. Quests missing from the guide and quest XP are listed in the report for a person to judge.",
    "",
  ].join("\n");

  return { name, date, markdown: out.join("\n"), patch, findings };
}
