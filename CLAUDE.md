# CLAUDE.md — WoW: Forever leveling addon (working name: Wayfinder)

You are building a free World of Warcraft: Forever addon by forking RestedXP's
open-source addon (github.com/RestedXP/RXPGuides). Read `docs/DESIGN.md`,
`docs/PIPELINE.md`, `docs/RESEARCH_INDEX.md` and `docs/FIELD_LOG.md` before
your first change. This
file holds the rules that apply to every session.

## What we are building

One addon. Three core modules:

1. **Leveling guide** — a continuous 1–60 speed-leveling route with step window,
   waypoint arrow and map pins. Inherited from RestedXP's engine; our work is
   content past level 22 and Forever-specific routing.
2. **Gear hunts** — upcoming upgrades for the player's class and spec, tracked
   like quests with the same arrow and pins.
3. **Class macros** — a per-class macro panel with one-click install.

Supporting modules (all optional, DESIGN § 5): recorder, data dump, field
log, opportunities (level-gated optional tasks matched to the player's
goals), and a display-only cooldown strip.

First slice: Horde Troll Warrior (Protection/tank), levels 1–22, then 1–60.
The level-by-level build for that character is the "Troll Warrior build" tab
of the research workbook.

## Hard rules (never break these)

- **Free forever.** No paid content, no premium tier, no in-game ads, purchase
  links or donation requests. (Blizzard UI Add-On Development Policy.)
- **Licence.** The project is CC BY-NC-SA 4.0 because it adapts RXPGuides.
  Keep `LICENSE`, keep `NOTICE.md` crediting RestedXP with a link to the
  upstream repo, and state that files were changed. Never add code or data
  whose licence is incompatible or unknown.
- **No GPL data, ever.** Questie and QuestieDB are GPL-3.0 (confirmed
  2026-11-15). Creative Commons names no licence compatible with
  CC BY-NC-SA 4.0, so nothing from Questie, QuestieDB, cMaNGOS-derived
  datasets or SimGearForever may be copied, converted or vendored into this
  repo. The only allowed use of Questie is optional runtime interop through
  its public API when the player has it installed.
- **No obfuscation.** All Lua and guide data ship as readable plain text.
  Remove or disable upstream's encrypted paid-guide import path.
- **No combat logic.** Never read or branch on combat state (auras, cooldowns,
  health, enemy casts). Forever applies Retail's "secret values" restrictions.
  Macros are static text; gear scoring uses item data, not combat data.
  The one permitted exception is display-only: the cooldown strip may pass
  Blizzard's opaque duration objects straight to Blizzard's Cooldown and
  StatusBar widgets (DESIGN § 5.6). It must never compare, compute on, or
  branch on those values.
- **Protected actions need a player click.** Casting, targeting and item use go
  through secure templates. Macro create/edit only out of combat
  (`InCombatLockdown()` check; defer to `PLAYER_REGEN_ENABLED`).
- **Do not copy protected content.** Nothing from RestedXP's paid guides,
  GearQuest Forever, UpQuest, Zygor, Joana, Wowhead, WarcraftDB, Icy Veins or
  any site's guide text or macro lists. Facts (a quest exists, an ability
  unlocks at a level) are fine to use; wording and compiled lists are not.
- **Research data is a seed, not a shipment.** Most IDs, levels and stats in
  the research workbook were read from Wowhead and are single-source. They
  tell you what to look for. A datum may ship only after the in-game dump, a
  recording, or an upstream file confirms it (see DESIGN § Data provenance).
  Where the game and the workbook disagree, the game wins.
- **Never invent game data.** Quest IDs, NPC IDs, item IDs, map IDs and
  coordinates must come from upstream files, an in-game dump or recording, or
  a named row of the research workbook. If you do not have it, mark the step
  `DRAFT` and add it to `docs/OPEN_QUESTIONS.md`. A plausible-looking wrong ID
  is the worst possible output.

- **Everything is optional.** Every feature ships with an on/off toggle in the
  options panel (DESIGN § 6). A feature that is off creates no frames and
  registers no events. Do not add a feature without its toggle and default.

## Facts about the platform (verified 2026-11-15; see RESEARCH_INDEX)

- Client: Retail-family (Mainline) API. `## Interface: 16001`.
  TOC suffix `_Forever.toc` (alias `_Camelot.toc`). Level cap 60. Patch
  1.60.1; no client patch has followed it, only server hotfixes.
- Project detection: `WOW_PROJECT_ID == WOW_PROJECT_CAMELOT` (reported as 18).
  Upstream also uses `addon.game == "FOREVER"` and a `#forever` guide tag.
- Install path: `World of Warcraft\_forever_\Interface\AddOns\<Addon>\`.
- Lua 5.1 sandbox: no file I/O, no network, no `os`/`io`. Lua's `require` is
  renamed `import` in this client. The only persistence is SavedVariables,
  written at logout or `/reload`.
- Documented as available (wiki, confirm in client): `C_QuestLog`,
  `C_Map.GetPlayerMapPosition` (nil in instances), `C_Spell.GetSpellInfo`,
  `C_Spell.GetSpellPowerCost`, `C_Item.GetItemStats` (base stats),
  `C_TooltipInfo`, `CreateMacro`. The old globals `GetSpellPowerCost` and
  `GetItemStats` are not listed for Forever.
- Creature and object GUIDs have obfuscated server and spawn IDs. Never key
  data on spawn IDs.
- Macro limits: 255 characters, 120 account slots, 18 per character.
- Wowhead "zone IDs" in the workbook are area IDs, not UiMapIDs. UiMapIDs for
  the new zones are unpublished; read them in game.

## How you verify work (you cannot run the game)

1. `luacheck` clean, TOC and XML manifests valid, guide linter clean.
2. Unit tests (Lua 5.1 + `busted`, WoW API stubbed) for anything with logic.
3. **In-game self-test and dump**: `/wf selftest` and `/wf dump` write results
   into SavedVariables. After Don runs them and reloads, read the
   SavedVariables file and the BugGrabber log. See `docs/PIPELINE.md`
   § In-game loop.
4. Never report something as working in-game unless a self-test result or
   Don's report says so. Say "untested in client" otherwise.

## Working agreements

- Keep the diff against upstream small and isolated (see DESIGN § Fork
  strategy). New features live in new files under `Modules/` and `Guides/wf/`.
- One concern per commit. Prefix: `core:`, `guide:`, `macros:`, `gear:`,
  `recorder:`, `tools:`, `docs:`.
- Every guide file carries a header comment with: level range, faction, race,
  class conditions, `STATUS: VERIFIED | DRAFT`, sources, and date.
- Every data file under `Data/` carries a `provenance` field per record
  (`dump`, `recording`, `upstream`, or `research:<tab>#<row>`).
- When research and the game disagree, the game wins. Update
  `docs/research/` and note the date.
- Corrections come from evidence. A change to guide data cites the Field log
  events, dump or recording that justify it (`docs/FIELD_LOG.md`). After a
  fix, the next session's report must show the finding gone.
- Stop and ask Don when: a licence is unclear, a rule above would be bent,
  an upstream rebase conflicts in engine code, or a decision is listed as
  "Don's call" in DESIGN.md.
