# DESIGN.md — product and architecture

Status: design baseline, revised 2026-11-15 after the research phase. Owner:
Don. Working name **Wayfinder** (slash command `/wf`); the name is Don's call
and is defined in one place (§ Rebrand map) so it can change cheaply.

## 1. Goal and non-goals

**Goal.** A free addon that takes a WoW: Forever player from level 1 to 60 on
one continuous route tuned for their faction, race and class, tells them which
gear upgrades are coming, and gives them working macros for their class.

**Where it stands against what exists (15 Nov 2026).**

| Addon | What it does | Gap we fill |
|---|---|---|
| RestedXP | Route addon; Forever routes to level 35, paid; 35–60 falls back to Classic routes | Free, and Forever-specific past 35 |
| GearQuest Forever | Gear upgrades; about 2.98 million downloads; closed source; stat values from Wowhead tooltips | Gear tied to the route you are already on; open source |
| OpenXP, FlowUp Forever | Free route addons, newly listed, quality unknown | Route + gear + macros in one |
| Questie | Quest pins; GPL-3.0; says its Forever data is incomplete | Optional companion, never a data source |

Nobody ships route + gear + macros together, free. GearQuest's size means the
gear module alone will not win on reach; the route is the product, and gear
and macros are what make it different.

**Non-goals.**
- No combat assistance of any kind (rotation helpers, cooldown trackers).
- No external overlay or companion app that draws over the game.
- No other game flavors (Retail, Classic Era, MoP, TBC, SoD) in our build.
- No raid or endgame guides; only attunement pickups before 60.
- Alliance and Skyborne content are out of scope until Horde 1–60 ships
  (Don's call to reopen).

## 2. Decisions already made

| Decision | Choice |
|---|---|
| Price | Everything free |
| Code base | Fork RXPGuides (CC BY-NC-SA 4.0) |
| Shape | In-game Lua addon only |
| Modules | Leveling guide, gear hunts, class macros |
| Route variation | Faction spine → race start → class layer → play-style options |
| First slice | Horde Troll Warrior, Protection |
| Macros | Written by us; one-click install out of combat |
| Guide delivery | Plain text shipped in the addon; no import strings needed |
| Quest data | Our own recorder and dump; Questie data is never copied (GPL-3.0) |

## 3. Fork strategy

Upstream releases every few days. The fork must stay rebasable.

- `upstream` remote = RestedXP/RXPGuides. `main` = ours. Rebase or merge
  upstream weekly; record the upstream commit in `docs/UPSTREAM.md`.
- **Engine files** (`RXPGuides.lua`, `GuideLoader.lua`, `functions.lua`,
  `GuideWindow.lua`, map/arrow code, libs): change only for rebrand, Forever
  fixes, and hook points. Every changed block gets a `-- WF:` comment.
- **Our code** lives in `Modules/` (new files) and registers through hook
  points, not by editing engine internals.
- **Our guides** live in `Guides/wf/` with their own `GuideList-wf.xml`.
  Upstream's public Forever guides are kept, credited, and loaded as the
  1–22 base.
- **How upstream handles Forever (read 15 Nov, confirm in P0):** there is no
  separate Forever folder or module. Forever is detected with
  `WOW_PROJECT_ID == WOW_PROJECT_CAMELOT` and `addon.game == "FOREVER"`, and
  guides are marked with a `#forever` header tag. The public repo's TOC has
  no 16001 interface line; the CurseForge Forever build adds it. Our TOC must
  add it.
- **Strip from our TOC** (do not delete history; just do not load):
  non-Forever TOCs and guide lists, SoD/hardcore/seasonal branches, paid-guide
  import UI, encrypted string decoding, RestedXP shop/links/ads, telemetry if
  any is found.

### Rebrand map (so we run side by side with RestedXP)

| Upstream | Ours |
|---|---|
| Addon folder / TOC name `RXPGuides` | `Wayfinder` |
| SavedVariables `RXPData`, `RXPDB`, `RXPSettings`, `RXPString`, `RXPCData`, `RXPCTrackingData`, `RXPCComms`, `RXPCSettings` | `WFData`, `WFDB`, … same suffixes |
| Global frame names and any `_G` exports prefixed `RXP` | prefix `WF` |
| Slash commands (`/rxp` …) | `/wf` |
| Addon message prefix `RXPGComms` | `WFComms` |
| Minimap/LDB object name | `Wayfinder` |
| In-game titles "RestedXP …" | "Wayfinder" + "based on RestedXP Guides" in the About panel |

First task in the pipeline is to inventory every such identifier with a
script, not by hand.

## 4. Data provenance (new)

Every record the addon ships carries where it came from:

| Provenance | Meaning | Allowed in a VERIFIED guide or data file |
|---|---|---|
| `dump` | Read from the game client by `/wf dump` | Yes |
| `recording` | Captured by the recorder during real play | Yes |
| `upstream` | Present in an RXPGuides public file | Yes |
| `research:<tab>#<row>` | From the research workbook | Only if that row is Primary or Confirmed in game; otherwise DRAFT |

The workbook is the map of what to look for. The dump and the recorder are
what make data shippable. `tools/dump-to-research` diffs a dump against the
workbook and lists every disagreement; the game wins.

## 5. Module designs

### 5.1 Leveling guide (inherited engine)

How upstream works (confirm by reading the source):
- Guides are a text DSL: `#` step tags, `.` element functions (`.accept`,
  `.turnin`, `.complete`, `.goto`, `.fp`, `.fly`, `.hs`, `.home`, …), `<<`
  conditions (faction, race, class, level), `#next` to chain guides.
- Events set flags; a ticker (default 0.075 s) evaluates step completion.
- Navigation: `UnitPosition` + HereBeDragons; arrow and pins.

Our additions:
- **Route layers.** One Horde spine per level band. Race-start guides feed
  into it. Class steps are inline with `<< Warrior` conditions (upstream's
  mechanism) rather than separate files.
- **Play-style options** (settings, read by guide conditions):
  `dungeons = none | once-each` and `weapon = shield | twohand`.
  Creators disagree on both; the player chooses. Published advice is to run
  each dungeon once with every quest in hand.
- **Draft labelling.** A guide with `STATUS: DRAFT` shows a small "Draft
  route" badge in the step window and a one-click "report a problem" that
  copies step ID, quest ID and position to an edit box.
- **Forever systems as optional steps:** cooking for the +5% kill-XP food;
  the Cozy Sleeping Bag chain (Horde start: southern Barrens, level 14+, up
  to 3% bonus XP); camping stops (off by default until measured); Library
  Books pickups; level-40 riding; dual spec at 40 (50g); Dalaran attunement
  at Tarren Mill; Onyxia attunement pickups.
- **Train steps** use spell IDs and learn levels (Spell IDs and Class
  abilities tabs) once the dump confirms them.
- **Talent prompts** keyed to talent points available, not character level
  (the Legacy perk "Talented" shifts points up to five levels earlier). Build
  data lives in `Data/Builds/<Class>.lua`. The Warrior Protection build is on
  the "Troll Warrior build" tab: levels 10–40 follow a published path; levels
  41–60 are our own design and ship labelled "Suggested".

Level bands and coverage (Horde):

| Levels | Zones and dungeons | What we have | Still needed |
|---|---|---|---|
| 1–12 | Durotar | Upstream Forever guide | Nothing |
| 12–22 | Barrens, Orgrimmar; Ragefire Chasm, Ruins of Lordaeron (15–20), Wailing Caverns | Upstream Forever guide; dungeon quest names | Dungeon detour steps |
| 22–30 | Stonetalon, Ashenvale, Thousand Needles, Hillsbrad; Excavation Site (24–29) | Upstream Classic public files as reference | Recording |
| 30–35 | Arathi, Alterac, Desolace; City of Dalaran (28–33) | Zone entry levels from one guide; Dalaran attunement chain | Recording |
| 35–45 | Stranglethorn, Swamp of Sorrows, **Riverglades** (36–44), **Shen'dralas** (quests 38–49); The Drowned City (35–40), Krol'dok Stronghold (40–45) | Riverglades: 105 Horde-doable quests with IDs and XP (265,140 XP). Shen'dralas: 43 quests. Krol'dok: boss order, quests, loot | Quest givers, coordinates, chain order; faction of 19 Shen'dralas quests |
| 45–55 | Tanaris, Feralas, Hinterlands, Un'Goro, Felwood, Azshara; Alcaz Prison (48–53) | Alcaz quests, loot by boss, access route | Boss order (disputed); recording |
| 55–60 | Plaguelands, Winterspring, Silithus; Blackmaw Hold (55–60), The Shaper's Terrace (58–60) | Blackmaw loot by boss; its quests open from level 45 | Almost everything about both dungeons |

Travel facts to encode: Horde reach Riverglades by boat from Tanaris to
Powderfuse Port, then Rog'mar (flight path); Shen'dralas is entered on foot
from Desolace through the Valley of Bones. Manor Mistmantle and "Excavation
Site - Bael Modan" appear in datamined lists but are not live: leave them out.

### 5.2 Recorder (new, `Modules/Recorder.lua`)

Purpose: turn a real play session into guide data, so nobody guesses IDs. It
is also the only route to quest givers and coordinates, since Questie's data
cannot be used.

- Off by default; `/wf record on`.
- Logs to SavedVariables: `QUEST_ACCEPTED` (questID), `QUEST_TURNED_IN`
  (questID, xp, money), objective progress, position + UiMapID at each event,
  the name of the NPC or object targeted at accept and turn-in, quest faction
  availability, flight taken, hearth use, level-ups, zone changes, quest
  reward item IDs and choices, `GetTime()` deltas.
- Do not key anything on creature spawn IDs (obfuscated in Forever).
- `tools/compile-recording` (Node/TypeScript, off-game) converts a
  SavedVariables recording into a draft guide file in upstream's DSL plus an
  XP-per-hour report per segment, and matches recorded quest IDs against the
  Riverglades and Shen'dralas tabs to show what was skipped.

### 5.3 Data dump (new, `Modules/DataDump.lua`)

`/wf dump` reads everything the client will tell us about the logged-in
character and writes it to SavedVariables. It is the confirmation step for
research data and the only source for costs. Targets are listed in
PIPELINE § P2 and RESEARCH_INDEX § Open items.

### 5.4 Class macros (new, `Modules/Macros.lua` + `Data/Macros/<Class>.lua`)

- Data record: `id`, `name` (≤16 chars, prefix `WF`), `icon`, `body`
  (≤255 chars), `minLevel`, `requires` (talent or item note), `specs`,
  `purpose`, `source`, `testedBuild`.
- Panel lists macros available at the player's level and spec; each row has
  Install / Update / Remove. Install uses `CreateMacro`/`EditMacro` out of
  combat only; if in combat, queue until `PLAYER_REGEN_ENABLED`.
- Never touch a macro the addon did not create. Handle full macro slots with a
  clear message. Per-character vs account slot is a setting.
- The Warrior starter set is the 14 ideas on the Macros tab; all are
  `testedBuild = nil` until a self-test or Don confirms. Note the Vanguard
  talent (level 25 in our build) removes the stance swap from the Charge
  macro, so that macro has two variants.
- One published guide says Forever macro syntax matches Classic (`/cast`
  without a rank, stance conditionals, `/startattack`, mouseover).
  `/castsequence`, `/equipslot` and `#showtooltip` are unconfirmed: the
  self-test probes them.
- Macro bodies are authored by us from ability names and standard
  conditionals; do not paste from guide sites.

### 5.5 Gear hunts (new, `Modules/GearHunts.lua`)

First read upstream's `ItemUpgrades.lua` and decide: extend it if it runs on
Forever, otherwise build beside it. Record the decision in
`docs/DECISIONS.md`.

- **v1 scope:** quest rewards on the active route. "Hunt" = an upcoming reward
  that scores as an upgrade; shown in a list and tracked with the guide's
  arrow. Seeds: the Quest rewards tab (34 items with stats and source quest).
- **v2:** dungeon drops for dungeons the route visits. Seeds: the Dungeon loot
  tab (79 items for Krol'dok, Alcaz and Blackmaw, with boss sources for two).
- **Item stats** come from `C_Item.GetItemStats` at runtime where the item is
  cached, with our seeded stats as the fallback, flagged by provenance.
- **Scoring:** per-spec stat weights in `Data/StatWeights/<Class>.lua`,
  editable in settings. No Forever stat weights or sim exist; two published
  tank gear lists disagree. Ship the Protection Warrior weights as
  "Placeholder weights" built from the one published survival priority
  (Stamina, Armor, Agility, Dodge and Parry, Defense).
- Tank targets by bracket for the first slice are on the Troll Warrior build
  tab (for example Twilight Barrier, the Krol'dok Warplate set, Fatebound
  Buckler, Bloodfur Bulwark).
- Memory budget: load class data on demand; target under 30 MB total addon
  memory in a normal session.

### 5.6 Cooldown strip (new, `Modules/CooldownStrip.lua`) — added 2026-11-16

Don's requirement: cooldown bars or timers on screen that never block the
player's view of the fight.

**What the platform allows (read 16 Nov; confirm in the self-test).**
- Forever ships Blizzard's built-in Cooldown Manager, placed through Edit
  Mode. Several addons already restyle it for Forever.
- Addons may *display* cooldowns but not read them. The wiki documents
  duration objects for this: `C_Spell.GetSpellCooldownDuration(spellID)`
  returns a DurationObject that is handed to
  `Cooldown:SetCooldownFromDurationObject()` or
  `StatusBar:SetTimerDuration()`. The widget draws the spiral or bar; our code
  never sees the numbers. Whether these calls exist in 1.60.1 is a self-test
  probe.
- Consequence: we cannot sort by time left, hide an ability when it is ready,
  flash, play a sound, or change anything based on a cooldown's state. This
  module stays inside the "no combat logic" rule: it only passes opaque
  values from Blizzard's API to Blizzard's widgets.

**Scope.** A small, preconfigured display for the build the guide gave the
player, with no setup. Not a general tracker (that is WeakAuras territory and
the restrictions make it a poor fight).

- Two groups, both click-through (`EnableMouse(false)`):
  - **Rotation strip:** up to 6 short cooldowns as one thin row.
    Protection Warrior default: Shield Block, Revenge, Thunder Clap, Taunt,
    Shield Bash, Bloodrage (Shield Slam replaces Bloodrage at 40).
  - **Big buttons:** up to 4 long cooldowns as small icons. Default:
    Berserking, Last Stand, Shield Wall, Retaliation.
- Entries come from `Data/Cooldowns/<Class>.lua` keyed by spec and level, so
  an ability appears when the player learns it. Spell IDs come from the dump.
- **Placement rules (the point of the feature):**
  - Keep-clear zone: the centre 40% of screen width and 50% of height holds
    nothing of ours.
  - Rotation strip default: centred horizontally, about 300 px below screen
    centre at 1080p (just under the keep-clear zone), above the action bars.
    Bars 14 px high or icons 32 px.
  - Big buttons default: lower left of centre, level with the strip, icons
    28 px.
  - Never overlap our own step window (right side) or arrow (top centre);
    the layout code checks this on load and after a move.
  - Out of combat the groups fade to 30% opacity; in combat 85%.
- **v1 (Don's decision, 2026-11-16): ship the suggested layout only.** One
  fixed default layout following the placement rules above, with an on/off toggle per group and
  nothing else to configure.
- **v2: player editing.** Presets (Under character, Above action bars, Left
  column), drag to move with a lock toggle, scale and opacity sliders, and
  choosing which abilities appear. Register with Edit Mode if the API allows
  an addon frame there; otherwise our own unlock mode. Build v1 so positions,
  sizes and the ability list already come from a settings table with
  defaults, so v2 is an options screen over existing data, not a rewrite.
- Off by default with a first-run prompt that also offers the alternative:
  "use Blizzard's Cooldown Manager instead", with a list of what to track for
  this build.
- **Fallback if the duration-object calls are missing in Forever:** ship only
  the "what to track" list and the layout advice for Blizzard's Cooldown
  Manager. Do not attempt a tracker built on combat events.

### 5.7 Field log (new, `Modules/FieldLog.lua`) — added 2026-11-16

A structured play log in SavedVariables that `tools/analyze-log` turns into a
corrections report: Lua errors, wrong coordinates and quest IDs, quests that
were never offered, missing quests, XP per hour by segment, and which
optional tasks and gear were actually taken. It is how each test run makes
the guide more accurate and faster. Full specification, event list and the
correction loop: `docs/FIELD_LOG.md`. It shares an event writer with the
Recorder and is built in P2 so it exists from the first in-game session.

### 5.8 Opportunities (new, `Modules/Opportunities.lua` + `Data/Opportunities.lua`) — added 2026-11-16

Don's requirement: as the character levels, surface extra tasks that have
become available and that benefit the choices the player has made for their
character.

- **Player goals.** A short first-run choice, changeable in options, stored
  per character: role (tank, damage, healer) and any of *reach 60 fastest*,
  *best gear for my role*, *gold*, *professions*, *collect everything*.
- **Data record:** `id`, `title`, `minLevel`, `maxUsefulLevel`, conditions
  (faction, race, class, spec), `benefit` tags with a size (for example
  `xp_bonus 3%`, `tank_gear shield`, `ability`, `weapon_skill`, `bag_slots`,
  `travel`, `legacy_point`), `cost` (minutes, gold), where to start it,
  prerequisites, `provenance`.
- **Behaviour.** When the character reaches `minLevel` and the conditions
  hold, the task appears in a "Now available" list, ranked by benefit to the
  chosen goals per minute of cost. Accepting one inserts its steps into the
  route as an optional detour; dismissing hides it. Never interrupts combat
  or blocks the main route.
- **Seed entries from the research workbook** (all need game confirmation):
  Defensive Stance quest at 10; Cozy Sleeping Bag chain at 14 (up to 3% XP);
  weapon skill training such as polearms at 20; Legacy points from 25;
  Berserker Stance and the Whirlwind weapon at 30; Dalaran attunement at 30;
  Desperate Barrier shield quest at 35; plate, riding and dual spec at 40;
  Krol'dok Warplate set at 40; Twilight Barrier; Library Books hand-ins at
  10, 20, 25 and 35 books; Tier 2 camping blueprints from dungeon bosses;
  Blackmaw Hold quests that open at 45.
- **Tuning.** The Field log records which opportunities are shown, taken and
  dismissed and how long each took, so the ranking is corrected from real
  play, not guessed.

## 6. UX principles

- **Everything is optional (Don's rule, 2026-11-16).** Every feature we
  provide has an on/off toggle in the options panel, and turning one off
  removes its frames, its events and its memory use, not just its visibility.
  No feature may depend on another being on, except where listed below.

  | Options entry | Default | Notes |
  |---|---|---|
  | Leveling guide (step window) | On | The core; off leaves only the modules below |
  | Waypoint arrow | On | Needs the guide |
  | Map and minimap pins | On | Needs the guide |
  | Talent prompts | On | "Suggested build" label |
  | Train-at-trainer steps | On | Needs the guide |
  | Optional detours: dungeons, camping, Library Books, Cozy Sleeping Bag | Dungeons once-each; the rest off | One toggle each |
  | Gear hunts | On | List and tracking separately toggleable |
  | Class macros panel | On | Never installs a macro without a click |
  | Cooldown strip: rotation group | Off, offered at first run | § 5.6 |
  | Cooldown strip: long-cooldown group | Off, offered at first run | § 5.6 |
  | Opportunities ("Now available" list) | On | § 5.8; player goals chosen at first run |
  | Field log | Off in releases, on in development builds | § 5.7; nothing leaves the computer |
  | Recorder | Off | For contributors |
  | Each automation (quest accept, turn-in, gossip, junk sale, repair) | As upstream | One toggle each |

  One "Wayfinder" page under Options > AddOns, grouped by module, with a
  master toggle per module and the finer toggles beneath it. A first-run
  panel shows the same list so the player chooses before anything appears.
- Looks and behaves like RestedXP on first run, so RestedXP users are at home.
- Honest labels: "Draft route", "Placeholder weights", "Untested macro",
  "Suggested build".
- Nothing commercial anywhere in the UI.

## 7. Don's calls still open

1. Final addon name and slash command.
2. Keep upstream locale files or ship English-only at first.
3. Whether party step-sync stays enabled.
4. Whether to accept community recordings, and under what contribution terms.
5. When to start Alliance and Skyborne.
6. Whether to offer optional Questie interop at all, or stay fully
   independent.
