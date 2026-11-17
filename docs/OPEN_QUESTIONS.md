# OPEN_QUESTIONS.md — what we do not know yet

Started 2026-11-16 (P0) from `RESEARCH_INDEX.md` § Open items and
`PIPELINE.md` § 7. Keep it current: every entry has an owner and a plan, and
is closed with the evidence that answered it.

Owner key: **Don** = Don decides or tests in game; **dump** = `/wf dump`
(P2); **selftest** = `/wf selftest` (P2); **recording** = recorder or field
log from real play (P3 onward); **CC** = Claude Code, from source or tooling.

## A. Decisions waiting for Don

| # | Question | Raised | Notes |
|---|---|---|---|
| A1 | Final addon name and slash command | DESIGN § 7 | Working name Wayfinder, `/wf` |
| A2 | Keep upstream locale files or ship English-only first | DESIGN § 7 | Affects how much of `lang/` and `locale/` P1 keeps |
| A3 | Whether party step-sync stays enabled | DESIGN § 7 | Depends on the comms findings in UPSTREAM_MAP |
| A4 | Whether to accept community recordings, and on what terms | DESIGN § 7 | |
| A5 | When to start Alliance and Skyborne | DESIGN § 7 | |
| A6 | Optional Questie interop, or fully independent | DESIGN § 7 | |
| A7 | May the research workbook and its conversions be published in the public repo? | 2026-11-16 | Most tabs are lists compiled from Wowhead; CLAUDE.md forbids copying compiled lists from Wowhead. Nothing is pushed until Don answers |
| A8 | Confirm WoW install path and account folder in `docs/ENV.md` | 2026-11-16 | Found on disk, not yet confirmed |

## B. Only the game can answer (RESEARCH_INDEX § Open items)

| # | Question | Owner | Plan |
|---|---|---|---|
| B1 | Rage, mana and energy cost of every ability rank | dump | `C_Spell.GetSpellPowerCost` over the Spell IDs and Class abilities tabs |
| B2 | Disputed Warrior values: Demoralizing Shout rank 5 (196, 204 or 210), Bloodthrill, crit rage bonus (double or 75% more), Whirlwind cost | dump | Tooltip text from the dump |
| B3 | Race base stats for all ten race variants, starting with Troll Warrior | dump | Character with no gear |
| B4 | UiMapIDs for Riverglades, Shen'dralas, Zephras Isle and the nine dungeons | dump / recording | Log UiMapID on every zone change |
| B5 | Quest givers, turn-in NPCs, coordinates and chain order for Riverglades and Shen'dralas | recording | P5 |
| B6 | Faction of the 19 unflagged Shen'dralas quests and the unflagged dungeon quests in Alcaz Prison and Blackmaw Hold | recording | P5, P6 |
| B7 | Boss order in Alcaz Prison (two guides disagree) and Blackmaw Hold (unpublished); everything about The Shaper's Terrace | recording | P6 |
| B8 | Whether the Krol'dok Compound Key is needed, and what it opens | recording | P5 |
| B9 | Hearthstone cooldown; whether flight paths are learned by visiting | selftest / Don | T2 or T3 card |
| B10 | Trainer contents: spell IDs, learn levels and prices per rank; whether Toughness and Improved Cleave are trainer spells | dump | Trainer dump mode at a Warrior trainer |
| B11 | Shaman Call of the Ancestors / Spirits levels; whether Lightwell and Lava Burst exist | dump | P7 |
| B12 | Macro command support: `/castsequence`, `/equipslot`, `#showtooltip`, stance conditionals | selftest | Macro conditional probes |
| B13 | A played Horde route for 30–60, with XP per hour by segment | recording | P4–P6 |

## C. Known unknowns to resolve early (PIPELINE § 7)

| # | Question | Owner | Plan |
|---|---|---|---|
| C1 | Does upstream run on Forever under a new name without engine changes? | Don (T1) | P1 gate |
| C2 | Are upstream's ItemUpgrades and Talents modules active on Forever? | CC, then selftest | UPSTREAM_MAP states what the source says; the client confirms |
| C3 | Macro conditional behaviour in the Forever client | selftest | Same as B12 |
| C4 | Any extra reuse terms on restedxp.com | CC | Licence sweep; record in `NOTICE.md` |
| C5 | Item stat availability in game for scoring (`C_Item.GetItemStats` returns base stats per the wiki) | selftest / dump | P2 |
| C6 | Whether the cooldown duration-object calls exist in 1.60.1 | selftest | DESIGN § 5.6 probes |

## D. Raised during P0

Entries are added here as the P0 work finds them (upstream map review,
licence sweep, tooling). See the P0 gate report in `docs/reports/`.

### D1. Licence sweep (2026-11-16, `docs/reports/2026-11-16-licence-sweep.md`)

| # | Finding | Evidence | Owner | Plan |
|---|---|---|---|---|
| D1.1 | `DB/mop/rares.lua` is copied from a GPLv3 addon (HandyNotes Pandaria Treasures). Not loaded on Forever, but it is in the tree | `DB/mop/rares.lua:3`; CurseForge licence page read 2026-11-16 | Don, then CC | Delete in P1 with the rest of the MoP data. Breaks "No GPL data, ever" until then |
| D1.2 | LibUIDropDownMenu (GPLv2 per WowAce) loads on Forever | `libs/embeds_Mainline.xml:6`; used at `RXPGuides.lua:2773` | Don, then CC | P1: remove and use the client's own menu API, or replace with our own code. Don's call |
| D1.3 | LibDeflate: header says zlib, bundled `LICENSE.txt` is LGPLv3, and the code says some routines came from GPLv2 sources | `libs/LibDeflate/LibDeflate.lua:64-72`; `libs/LibDeflate/LICENSE.txt` | Don, then CC | P1: it is only needed by the import path we remove; drop it if nothing else needs it |
| D1.4 | `CptStadicsVendorTreasures.lua` is CC BY-NC 3.0 (a different licence from ours) and loads on Forever | `CptStadicsVendorTreasures.lua:1-5`; `RXPGuides.toc:119` | Don | Drop the module, or keep it with attribution in `NOTICE.md` |
| D1.5 | LibDataBroker-1.1 has no confirmed licence | WowAce lists "All Rights Reserved"; no licence file | Don | Drop the LDB object or keep and record as unconfirmed |
| D1.6 | Paid-guide decrypt and import path is in the code, with one function name hidden as a byte array | `GuideLoader.lua:380-470, 590-640, 814-827`; `DB/shared.lua:37` | CC | Remove in P1 (CLAUDE.md "No obfuscation") |
| D1.7 | restedxp.com terms could not be read by an automated fetch (Cloudflare queue, 403) | Sweep § 6 | Don | Don reads https://shop.restedxp.com/terms-conditions/ and the guide article in a browser. Closes C4 |
| D1.8 | Some upstream data has no recorded source (`DB/*/SpiritHealerDB.lua`, `locale/NPCnames.lua`, dangerous mobs, stat weights, flight times). No Questie or MaNGOS traces found | Sweep § 3 | Don | Accept as `provenance: upstream`, or re-derive the Forever subsets from the dump |
| D1.9 | Dormant debug tool that reads quest zones from an installed Questie | `DB/questDB.lua:836-890` | CC | Remove in P1; keep only runtime interop if Don keeps Questie interop (A6) |
| D1.10 | Ace3 copyright notice is not in the bundled files; its licence requires it | Sweep § 4 | CC | Add to `NOTICE.md` |

### D2. Upstream map and identifier inventory (2026-11-16, `docs/UPSTREAM_MAP.md`, `docs/reports/identifier-inventory.md`)

| # | Finding | Evidence | Owner | Plan |
|---|---|---|---|---|
| D2.1 | Upstream guide files call the globals `RXPGuides.RegisterGuide` (216 files, 720 calls on Forever) and `RXP.enabledLocale` (36 files). Unmodified guide files need those globals, which collide with RestedXP when both addons are loaded | Inventory § 4; UPSTREAM_MAP B6 | Don | P1 decision: (a) rewrite the two global names in the upstream guide files with a script at each sync, or (b) keep the globals and declare the addons mutually exclusive. DESIGN § 3 wants both installed side by side, which needs (a) |
| D2.2 | The upstream engine reads and branches on combat state: `.cooldown` (95 uses in Forever guides) and `.aura` (48 uses) guide functions, Tips "emergency actions" on player health (on by default), a breath-timer tip, and others | UPSTREAM_MAP B18 | Don | P1 decision: remove or disable each, or accept upstream's behaviour where Blizzard's secret values already make it inert. CLAUDE.md "No combat logic" says remove |
| D2.3 | Targeting can call the protected `TargetUnit` from a timer and hides the client's forbidden-action dialog for every addon | `Targeting.lua:120-150, 541-566`; UPSTREAM_MAP B18 | Don, then selftest | Whether it is active on Forever depends on a client value. Conflicts with "Protected actions need a player click". Remove in P1 |
| D2.4 | Two addon comm prefixes, not one: `RXPGComms` and `RXPLTComms` | `Communications.lua:19`; `LevelingTracker.lua:22` | CC | Rename both in P1. DESIGN § 3 rebrand map lists one |
| D2.5 | Collisions a folder rename does not fix: 18 AceGUI widget types `RXPV2*`, AceEvent messages `RXP_*`, macros `RXPTargeting` and `RXPFollow`, 13 key bindings, named frames, 8 static popups, hard-coded texture paths in `UI/V2/ScrollBarTemplate.xml`, unprefixed leaked globals (`ConvertID`, `GetMapID`, `GetTableLength` and others) | Inventory § 4 and § 6 | CC | P1 rename list. The inventory tool is re-run after the rename to show what is left |
| D2.6 | The paid-guide import path is tied into login-time cache loading, stores a Battle.net value in `RXPData.cache`, and has more entry points than the import window (`RXPGuides.ImportGuide` global, level-splits import) | UPSTREAM_MAP B7 | CC | P1 strip needs its own reviewed plan; not a one-line removal |
| D2.7 | Upstream's ItemUpgrades and Talents modules do not run on Forever. Answers C2 from source | `ItemUpgrades.lua:6`; `Guides/Talents/classic-*.lua:3` | selftest | Confirm in client. Our gear and talent modules cannot reuse them as they are |
| D2.8 | Upstream already has per-dungeon toggles, a parallel dungeon guide group, and a first-run "Guide Configurator" where the player picks the guide | UPSTREAM_MAP A10, A6, B10 | Don | DESIGN § 5.1 and § 6 planned our own versions. Decide whether to reuse upstream's |
| D2.9 | Forever guides write `.goto` targets as world coordinates (`mapID/instance,a,b`), with the two numbers in the opposite order to `UnitPosition`'s first two returns | `functions.lua:1942-1943`; `libs/HereBeDragons/HereBeDragons-2.0.lua:661-668` | CC | The recorder (P3) must emit the same order. Untested in client |
| D2.10 | Unknown or failing `.tag` lines and unknown `#tags` fail silently unless debug mode is on. Upstream guides already contain misspelt tags | UPSTREAM_MAP A2, A5 | CC | The guide linter (P1/P3) is the only guard |
| D2.11 | Three `#next` targets do not exist in the public repo: `22-24 Hillsbrad`, dungeon-group `12-17 The Barrens`, `21-30 Silverpine/Hillsbrad AoE` | UPSTREAM_MAP A10 | CC | Our 22+ content starts where the Horde chain ends |
| D2.12 | Upstream sends a version/level/XP/guide-name announce to the party addon channel on login and on joining a group, and flight-time messages to party chat are on by default | UPSTREAM_MAP B9 | Don | Feeds decision A3 |
| D2.13 | A "Join Discord" button and feedback-form text point players at RestedXP's Discord. No shop, purchase or telemetry code found | UPSTREAM_MAP B8 | CC | Remove in P1 rebrand |
| D2.14 | DESIGN § 3 and CLAUDE.md state things the source contradicts (see the P0 gate report § Differences) | P0 gate report | Don | Don approves the edits to DESIGN.md and CLAUDE.md |

### D3. Tooling and environment (2026-11-16)

| # | Finding | Evidence | Owner | Plan |
|---|---|---|---|---|
| D3.1 | Upstream's `.github/workflows/package.yml` runs the release packager on every push to `main` and uses `actions/checkout@v2`. On the fork it will run and probably fail | `actionlint` output; workflow file | Don | Disable or adapt in P1. Until then expect a red "package" run beside our CI |
| D3.2 | CI has not run on GitHub. Nothing is pushed | — | Don | Needs Don's go-ahead to push and Actions enabled on the fork |
| D3.3 | Something on Don's PC deletes executables. `.tools\lua51\bin\lua.exe` was removed again after the Lua checks had passed, and `C:\Python314\python.exe` is gone, so the local Lua checks cannot run or be rebuilt right now. Avira and McAfee are both active | `tools\dev\lua-checks.ps1` exit 1 "lua.exe not found"; checked on disk 2026-11-16 | Don | Check antivirus quarantine, restore or reinstall Python 3, exclude `.tools\` from scanning, then run `tools\dev\setup-lua.ps1`. CI on GitHub is not affected |
| D3.4 | 19 file-name case mismatches in upstream manifests (for example `V2\Manifest.xml` vs `manifest.xml`). Harmless on Windows; untested elsewhere | `tools/check-manifests/baseline.json` | CC | Recorded as a baseline; fix only if a client rejects them |
| D3.5 | RESEARCH_INDEX row counts differ from the workbook for Flight paths (33 vs 34), Zone IDs (30 vs 31) and Class abilities (359 vs 358); four tabs have no count; a hidden tab "Dropdown options" is not listed | `npm run research:convert` output | Don | Informational. RESEARCH_INDEX not edited |

## Closed

| # | Question | Answer | Evidence | Date |
|---|---|---|---|---|
| — | Does the public repo's TOC carry a 16001 interface line? | Yes | `RXPGuides.toc:1` at upstream commit `22e6ce26` lists `16001` | 2026-11-16 |
| — | Is there a separate Forever guide folder upstream? | Yes | `Guides/forever/`, `DB/forever/`, `Guides/GuideList-forever.xml` exist at `22e6ce26` | 2026-11-16 |
