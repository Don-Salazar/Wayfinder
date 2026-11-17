# PIPELINE.md — how the build runs in Claude Code

This is the coding pipeline: phases, gates, agent roles, and the loop that
substitutes for not being able to run the game.

## 0. Inputs Claude Code needs from Don (ask once, store in docs/ENV.md)

- GitHub repo for the fork (owner/name) and confirmation it is public.
- Absolute path of the WoW install (the folder containing `_forever_`).
- WoW account folder name under `_forever_\WTF\Account\` (for reading
  SavedVariables).
- Final addon name (or approval to proceed with the working name).
- The research workbook exported as `docs/research/verified.xlsx` (download
  from the "WoW: Forever Addon — Verified Information" sheet). First tooling
  task (`tools/research-to-md`) converts each tab to CSV + Markdown.
  `docs/RESEARCH_INDEX.md` says what each tab is and how far to trust it.
- Later, when publishing: CurseForge and Wago project IDs. API tokens go into
  GitHub repository secrets by Don; never into the repo or the chat.

## 1. Repo layout (target)

```
/                      upstream engine files (minimal diffs, tagged -- WF:)
/Modules/              our new modules (Recorder, FieldLog, DataDump, Macros,
                       GearHunts, Opportunities, CooldownStrip, SelfTest)
/Data/Macros/          macro data per class
/Data/Builds/          talent builds per class/spec (provenance per record)
/Data/StatWeights/     stat weights per class/spec
/Guides/forever/       upstream public Forever guides (unchanged, credited)
/Guides/wf/            our guides + GuideList-wf.xml
/tools/                Node/TS: lint-guides, compile-recording, analyze-log,
                       dump-to-research, inventory-ids, read-savedvars,
                       research-to-md
/tests/                busted specs + wow-api stub
/docs/                 DESIGN, PIPELINE, RESEARCH_INDEX, FIELD_LOG, DECISIONS,
                       OPEN_QUESTIONS, UPSTREAM, ENV, research/, reports/,
                       testcards/
/.github/workflows/    lint+test on push; release on tag (BigWigs packager)
LICENSE  NOTICE.md  CLAUDE.md  .luacheckrc  .pkgmeta  Wayfinder_Forever.toc
```

## 2. Phases and gates

Each phase ends at a gate. Do not start the next phase until the gate passes
or Don waives it in writing.

### P0 — Bootstrap
- The project folder is already a clone of Don's GitHub fork of RXPGuides
  with the handoff files added (see `HANDOFF_README.md`). Add the `upstream`
  remote pointing at RestedXP/RXPGuides, fetch it, and record the commit in
  `docs/UPSTREAM.md`. Commit the handoff files as the first commit of ours.
- Add LICENSE check, `NOTICE.md`, `.luacheckrc` (WoW globals), `busted`,
  Node tooling, CI workflow (lint + tests).
- Convert the research workbook to `docs/research/*.md`.
- **Read upstream for real**: write `docs/UPSTREAM_MAP.md` describing load
  order, the guide DSL (every tag and function actually present), the step
  engine, saved variables, and how Forever is detected. The research notes on
  the engine came through a summarizing fetch and are not line-checked.
- Confirm in the source how Forever is detected and tagged
  (`WOW_PROJECT_CAMELOT`, `addon.game == "FOREVER"`, the `#forever` guide
  tag) and which interface line the shipped Forever build uses; the public
  repo's TOC had no 16001 line on 15 Nov.
- Licence sweep: confirm no file in the tree derives from Questie, QuestieDB
  or another GPL dataset; add a CI check that fails on new files without a
  known origin.
- **Gate:** CI green on an unmodified fork; UPSTREAM_MAP reviewed by a second
  agent against the source.

### P1 — Rebrand and strip
- `tools/inventory-ids` lists every addon-name, SavedVariables, global, slash
  command, comm prefix and UI string to change. Apply the Rebrand map in
  DESIGN § 3.
- Forever-only TOC. Strip per DESIGN § 3.
- Audit embedded libraries: name, version, licence → `docs/LIBRARIES.md`.
- **Gate (in-game T1):** addon loads on Forever next to RestedXP with zero
  Lua errors; upstream Durotar guide runs for a fresh Troll.

### P2 — Self-test harness
- `Modules/SelfTest.lua`: `/wf selftest` runs the checks below and writes a
  structured result table to SavedVariables with build number and timestamp.
- Checks (from the research "Checks" tab): quest events and quest-log calls
  return readable values; `UnitPosition` works in the open world; quest
  accept/complete/reward and gossip calls exist and are callable; junk-sell
  and repair calls exist; `CreateMacro` round-trip out of combat with slot
  counts; item stat read for a known item; macro conditional parsing probes;
  HereBeDragons loads; upstream ItemUpgrades/Talents modules load;
  cooldown display probes (`C_Spell.GetSpellCooldownDuration`,
  `Cooldown:SetCooldownFromDurationObject`, `StatusBar:SetTimerDuration`,
  whether an addon frame can register with Edit Mode) for the cooldown strip
  in DESIGN § 5.6.
- `tools/read-savedvars` parses the SavedVariables Lua into JSON for you.
- **Data dump** (`/wf dump`, `Modules/DataDump.lua`): the game client is the
  primary source for numbers; third-party databases are only cross-checks
  (Wowhead blocked automated reads twice on 2026-11-10 and its Forever data
  contains entries from other game versions). The dump writes to
  SavedVariables, for the logged-in character:
  - every known and trainer-listed class ability and rank: spell ID, name,
    rank, level learned, cost, cooldown, range, and the full tooltip text;
  - all three talent trees: name, tier, column, max rank, prerequisites, and
    tooltip text per rank;
  - racial traits with tooltip text;
  - quests in the log: ID, level, objectives, reward items, reward XP;
  - stats for equipped and bag items;
  - client build number and date.
  Chunk the work across frames so it cannot freeze the client. Documented as
  available in Forever (wiki, confirm at this gate): `C_Spell.GetSpellInfo`,
  `C_Spell.GetSpellPowerCost`, `C_Item.GetItemStats`, `C_TooltipInfo`,
  `C_QuestLog`, `C_Map.GetBestMapForUnit`. The old globals
  `GetSpellPowerCost` and `GetItemStats` are not listed for Forever.
  **Priority targets** (the list in RESEARCH_INDEX § Open items):
  - power cost of every ability rank, seeded from the spell IDs on the Spell
    IDs and Class abilities tabs (`C_Spell.GetSpellPowerCost`);
  - the disputed Warrior values (Demoralizing Shout rank 5, Bloodthrill,
    Defiance) from tooltip text;
  - base stats of the character with no gear, for race base stats;
  - UiMapID of the current zone on every zone change, to build the map table;
  - a trainer dump mode: when a class trainer window is open, record every
    listed spell, rank, level and price;
  - item stats for every item ID on the Quest rewards and Dungeon loot tabs
    that the client has cached.
  `tools/dump-to-research` converts a dump into `docs/research/game-data/`
  and diffs it against the research workbook, listing every disagreement.
- **Field log** (`Modules/FieldLog.lua`, `tools/analyze-log`): build the event
  writer, the ring buffer and the analyzer now, per `docs/FIELD_LOG.md`, so
  every later in-game session produces a report. At this stage it logs
  session, probe, error, blocked, quest, xp, level and note events; step
  events switch on in P3.
- **Gate (in-game T2):** Don runs `/wf selftest` and `/wf dump`, reloads; results recorded in
  `docs/research/selftest-<date>.md`; every failing check has an entry in
  OPEN_QUESTIONS with a plan.

### P3 — Troll Warrior 1–22 (first public alpha)
- Wire upstream Forever Durotar and Barrens guides as the base.
- Add Warrior class layer steps verified against upstream files; add dungeon
  detour options (Ragefire Chasm, Ruins of Lordaeron, Wailing Caverns).
- Macros module + Warrior data (levels 1–22 subset).
- Play-style settings (dungeons, weapon).
- Options page and first-run panel per DESIGN § 6; every feature toggleable.
- Opportunities module with the level 10-22 seed entries (DESIGN § 5.8).
- Cooldown strip v1 if the T2 probes passed; otherwise the fallback list.
- Field log step events on; first `tools/analyze-log` report from Don's run.
- Release pipeline: `.pkgmeta`, tag-driven GitHub Action.
- **Gate (in-game T3):** a fresh Troll Warrior reaches 22 following only the
  guide; macros install and work; Don approves alpha release.

### P4 — Recorder and 22–35
- Recorder module + `tools/compile-recording`.
- Draft 22–35 guides from upstream Classic public files and named sources;
  mark DRAFT. Don plays the band with the recorder on; compile; reconcile;
  flip to VERIFIED.
- **Gate:** 22–35 VERIFIED for Troll Warrior.

### P5 — 35–45 (the Forever band)
- Riverglades, Shen'dralas, new Stranglethorn/Desolace quests; The Drowned
  City and Krol'dok Stronghold as detours.
- Research now gives quest IDs, levels and XP for 105 Riverglades quests and
  43 Shen'dralas quests, plus lead-in quests from other zones. It does not
  give quest givers, coordinates or chain order: the recording supplies
  those. `tools/compile-recording` reports which listed quests the recording
  missed, so a second pass can pick them up.
- Resolve from the recording: the faction of the 19 unflagged Shen'dralas
  quests; whether the Krol'dok Compound Key is needed; Krol'dok boss order.
- **Gate:** 35–45 VERIFIED.

### P6 — 45–60 and gear hunts v1
- Remaining bands; attunement pickups; gear hunts from recorded rewards.
- **Gate:** one character completes 1–60 on the guide alone.

### P7 — Widen
- Other Horde starts and classes, community recordings, dungeon gear hunts,
  Alliance (if reopened).

## 3. In-game loop (the feedback you do not otherwise have)

1. You: build, lint, test; symlink or copy the addon into
   `<WoW>\_forever_\Interface\AddOns\`. Write a short test card in
   `docs/testcards/T<n>.md`: exactly what Don should do and type, in order,
   and what he should see.
2. Don: launches the game (full restart when files were added), follows the
   card, runs `/wf selftest` or `/wf record`, then `/reload` or logs out.
3. You: run `tools/read-savedvars` on
   `<WoW>\_forever_\WTF\Account\<ACCOUNT>\SavedVariables\Wayfinder.lua` and
   the BugGrabber saved variables, then `tools/analyze-log`; commit the report
   under `docs/reports/`; propose patches with log evidence; fix; repeat.
   The next session's report must show each fixed finding gone
   (`docs/FIELD_LOG.md` § 4-5).

Keep test cards under ten steps. Batch questions for Don into the card rather
than asking one at a time.

## 4. Agent roles (subagents in Claude Code)

| Role | Does | Must not |
|---|---|---|
| Orchestrator (main session) | Plans phases, owns gates, talks to Don | Write guide data from memory |
| Upstream analyst | Reads RXPGuides source, maintains UPSTREAM_MAP, handles rebases | Change behaviour |
| Engine engineer | Rebrand, strip, hook points, new modules | Edit guides |
| Guide author | Writes DSL guide files from recordings and cited sources | Invent IDs or coordinates |
| Guide reviewer (fresh context) | Lints and cross-checks every guide against sources; rejects uncited IDs | Fix silently; it reports |
| Macro author | Writes macro bodies and data; length and syntax checks | Copy published macro lists |
| Researcher | Fills OPEN_QUESTIONS from the web; records source + date | Mark anything verified without a source |

Review rule: nothing merges on the word of the agent that wrote it. Guides and
macros get the fresh-context reviewer; engine changes get tests plus a second
read.

## 5. Automated checks

- `luacheck` with WoW globals; zero warnings in our files.
- TOC/XML manifest check: every listed file exists; no non-Forever files.
- `tools/lint-guides`:
  - header present (range, faction, STATUS, sources, date);
  - every DSL tag/function is one that UPSTREAM_MAP lists;
  - every quest ID appears in a cited source file or a recording;
  - `#next` targets exist; conditions parse; coordinates in 0–100;
  - no step text copied from known third-party guide files (hash check
    against upstream files is fine; upstream text is licensed for reuse).
- Macro checks: body ≤255 chars, name ≤16, no unknown slash commands,
  `#showtooltip` first, requires/minLevel present.
- Licence check: every file has a known origin (upstream, ours, or a library
  listed in LIBRARIES.md).
- Toggle check: every entry in the DESIGN § 6 options table exists in the
  settings defaults, and a test confirms each module creates no frames and
  registers no events when its toggle is off.
- Unit tests: recorder event handling, macro installer state machine
  (combat deferral, full slots, foreign macros), gear scoring, settings
  migration.

## 6. Definition of done (per change)

- Lint, tests and guide linter pass.
- Docs touched if behaviour or data changed.
- In-game status stated honestly: "verified in client on <date>" or
  "untested in client".
- No new entries in OPEN_QUESTIONS left unowned.

## 7. Known unknowns to resolve early

- Whether upstream runs on Forever under a new name without engine changes.
- Whether upstream's ItemUpgrades and Talents modules are active on Forever.
- Macro conditional behaviour in the Forever client.
- Hearthstone cooldown; whether flight paths are learned by visiting.
- Any extra reuse terms on restedxp.com (read them; record in NOTICE.md).
- Item stat availability in-game for scoring (`C_Item.GetItemStats` returns
  base stats per the wiki).
- UiMapIDs for the new zones and dungeons (unpublished).
- Quest givers, coordinates and chain order for Riverglades and Shen'dralas
  (recording); quest IDs and XP are already in the workbook.
- Boss order in Alcaz Prison (two guides disagree) and Blackmaw Hold
  (unpublished); all of The Shaper's Terrace beyond one guide's outline.
- A played Horde 30–60 route: none exists in any source as of 15 Nov, so
  ours will be the first and must come from recordings.
- The full open list is RESEARCH_INDEX § Open items; copy it into
  `docs/OPEN_QUESTIONS.md` in P0 and keep it current.
