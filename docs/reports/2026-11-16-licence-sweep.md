# P0 licence sweep: Wayfinder fork of RXPGuides

- Tree swept: `C:\Projects\Wayfinder - WoW Forever Add-On`, HEAD `c86d098b` (our docs commit) on top of upstream `22e6ce26` ("Added forever FP data", Zarant, 2026-11-14). 1,427 tracked files, plus untracked `docs/ENV.md`, `docs/OPEN_QUESTIONS.md`, `docs/UPSTREAM.md`.
- Searches used `git grep -i` over tracked files. Our own handoff docs (`docs/`, `CLAUDE.md`, `HANDOFF_README.md`, `KICKOFF_PROMPT.md`) were left out so they would not match themselves. `lang/` (translated copies of `Guides/`) was included unless a search says otherwise.
- Date of sweep: 2026-11-16. Nothing in the project tree was changed.
- These are facts gathered for Don to decide on. They are not legal advice.
- Tags: **[TREE]** = read in tree, **[WEB url, date]** = read on the web, **[GK]** = from general knowledge (unverified), **[NF]** = not found.

---

## 1. Top-level licence facts

| # | Finding | Tag |
|---|---|---|
| 1.1 | `LICENSE` (352 lines) begins "Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International". It contains Sections 1–8 and the CC trademark/footer paragraph. I compared it word by word (case and punctuation stripped) with `https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.txt`: 2,918 words against 2,916, match ratio 0.99966. The only difference is one extra occurrence of "Creative Commons". The layout (`-   a.`) suggests it was converted from Markdown. **Conclusion: it is the full CC BY-NC-SA 4.0 legal code.** | [TREE] + [WEB creativecommons.org legalcode.txt, 2026-11-16] |
| 1.2 | `LICENSE` was added in commit `3b9212eb` ("Added a software license", Zarant, **2023-12-29**). The repository's first commit is `879f879d` (2021-04-09). About 2.7 years of code had no licence file, from about 30 distinct commit authors. No CLA or contributor terms were found. | [TREE] |
| 1.3 | `readme.md` (complete): "# RestedXP Guides … This is a platform to write in-game leveling guides for WoW Classic … https://www.restedxp.com/create-your-own-restedxp-guide/". It makes no licence statement. | [TREE] |
| 1.4 | `.pkgmeta`: `ignore: Scripts, Docs, readme.md`; `enable-toc-creation: yes`. Packaged releases therefore leave out `Scripts/`. No licence or notice field. | [TREE] |
| 1.5 | TOCs (`RXPGuides.toc:8`, `RXPGuides_TBC.toc:4`, `RXPGuides_Vanilla.toc:5`): `## Author: RestedXP`. They also carry `X-Curse-Project-ID: 486246`, `X-Wago-ID: ZKbebq61` and `OptionalDeps: Questie, RXPGuides_Themes`. No `X-License` field. (Side note: `RXPGuides.toc:1` already lists `16001`.) | [TREE] |
| 1.6 | No upstream source file has its own licence header, except the third-party files covered in §2–§4. No `NOTICE`, `COPYING` or `AUTHORS` file exists. | [TREE] |
| 1.7 | **Why GitHub reports `NOASSERTION`.** The GitHub API returns `license: {spdx_id: "NOASSERTION", name: "Other"}` for RestedXP/RXPGuides. GitHub's detector (licensee) only recognises licences in the choosealicense.com set. That set has CC-BY-4.0, CC-BY-SA-4.0 and CC0, but **no NonCommercial CC licence**, so the file is reported as "Other". The file itself matches the official text (1.1), so this is not a defect in the file. Ace3 shows the same `NOASSERTION` for the same reason: it uses a non-standard licence. | API result [WEB api.github.com/repos/RestedXP/RXPGuides, 2026-11-16]; explanation [GK] |

## 2. GPL / Questie / MaNGOS evidence search

Terms searched, case-insensitive: `Questie`, `QuestieDB`, `mangos`, `cmangos`, `vmangos`, `trinity`, `azerothcore`, `GPL`, `GNU General Public`, `wowhead`, `classicdb`, `SimGear`, `licen[cs]e`, `copyright`, `all rights reserved`, `author`. I also searched for other likely sources: `pfquest`, `zygor`, `joana`, `guidelime`, `auto pilot`, `gathermate`, `handynotes`, `rarescanner`, `warcraftdb`, `icy veins`, `curseforge`, `wowace`, `github.com`, `derived from`, `ported from`, `based on`, `taken from`, `borrowed`, `credit`, `db2`, `dbc`, `wago`, `leatrix`, `weakauras`. Finally I searched for Questie's DB field names (`npcDrops`, `objectDrops`, `preQuestSingle`, `preQuestGroup`, `exclusiveTo`, `questStarts`, `questEnds`, `startedBy`, `finishedBy`, `requiredRaces`, `requiredClasses`, `breadcrumbForQuestId`, `spawns =`, `waypoints =`).

### 2a. Runtime interop with an installed Questie (allowed category)
All code-level Questie references are runtime calls into a Questie install if one is present. No Questie data is bundled. **[TREE]**
- `functions.lua:494-495`: `if _G.QuestieLoader then db = _G.QuestieLoader:ImportModule("QuestieDB") end; addon.questieDB = db`.
- `functions.lua:830-860`: reads quest objectives with `db:GetQuest(id)`, `q.ObjectiveData` and `db:GetNPC(objId)` at runtime (`qInfo[i] = {..., questie = true}`).
- `functions.lua:1065-1100, 1240-1248`: reads `quest.preQuestSingle` / `quest.preQuestGroup` from the object that `db:GetQuest(id)` returns at runtime, and calls `db:IsDoable(id)`. These are the only places Questie's field names occur. They read Questie's live objects and do not define any data.
- `DB/questDB.lua:1675-1690`: runtime zone lookup `db:GetQuest(q.id).Zone` for the quest-prep panel.
- `Communications.lua:363-364, 381-382, 400`: suppresses party announcements when `_G.Questie` is loaded.
- `SettingsPanel.lua:2195-2201, 3556-3560`: options "Ignore Questie announcements" and "…(Requires Questie)" (the second is `hidden = true -- Not used`).

### 2b. Dev/debug path that could have been used to pull Questie data into files (amber, weak)
- `DB/questDB.lua:836-890` [TREE]: a debug-only (`hidden = not addon.settings.profile.debug`) multi-line "Debug" input box. Its `set` handler gsubs pasted text of the form `[id] = {` and looks up `db:GetQuest(id).Zone` from QuestieDB. The line that would have written `["zone"] = %d` back into the text is **commented out** (`--return format('%s%s%s\n    ["zone"] = %d,',...)`, about line 885). The tool was therefore built to annotate a quest table with Questie zone IDs. However, **no `["zone"]` / `zone =` fields exist in any `DB/*/quest.lua`** (count 0 in all seven), and `addon.QuestDB` is built at runtime from the guides (`functions.lua:7762-7777`), not shipped. Evidence that Questie data reached a shipped file: **none found**. The tool's existence is the only signal.

### 2c. GPL or other third-party-licensed material found in the tree
| Path | Evidence | Assessment |
|---|---|---|
| **`DB/mop/rares.lua:3`** (1,136 lines; loaded only for MoP via `DB/mop.xml:8`) | `--Taken from https://www.curseforge.com/wow/addons/handy-notes-pandaria-treasures`. The file holds rare/treasure records (npc IDs, coords, names, notes) such as `[376] = { [50339] = { ... ".rare 376,37.00,25.60,npc:Sulik'shor:50339;" ...`. Added in `1dd34659` "Mop beta support" (Zarant, 2025-05-02). [TREE] The CurseForge page lists the source addon's licence as **"GNU General Public License version 3 (GPLv3)"**. [WEB https://www.curseforge.com/wow/addons/handy-notes-pandaria-treasures, 2026-11-16] | **RED.** Self-declared copy of GPLv3 data. This conflicts with the "No GPL data, ever" rule even though it does not load on Forever. |
| **`libs/mainline/LibUIDropDownMenu/LibUIDropDownMenu.lua`** + `LibEasyMenu.lua` + `.xml` (header `$Id: LibUIDropDownMenu.lua 135 2024-02-05 arithmandar`) | **Loaded on Forever**: `RXPGuides.toc:26` loads `libs\embeds_Mainline.xml [AllowLoadGameType standard,camelot]`, and that file includes `mainline\LibUIDropDownMenu\LibUIDropDownMenu.xml`. Used at `RXPGuides.lua:2773` (`LibStub:GetLibrary("LibUIDropDownMenu-4.0", true)`). No licence statement in the bundled files. [TREE] The WowAce project page licence is "GNU General Public License ver…" and the licence page title is **"The GNU General Public License (GPL)"**, with text "Copyright (C) 1989, 1991 Free Software Foundation" (that is, **GPLv2**). [WEB https://www.wowace.com/projects/libuidropdownmenu and https://www.wowace.com/project/268264/license, 2026-11-16] | **RED.** GPLv2 code shipped and loaded in the Forever build. See §4. |
| **`libs/LibDeflate/LibDeflate.lua`** v1.0.2 | The file header says zlib (`:9`, `:31-49`). Its credits list `LibCompress … Licensed under GPLv2 … For the code to create customized codec` (`:64-69`) and `WeakAuras2 … Licensed under GPLv2. For the 6bit encoding and decoding` (`:70-72`). Code comments at `:2856-2860` and `:3114-3118`: "implemented by Galmok … From LibCompress … which is licensed under GPLv2. The code has been modified by the author of LibDeflate." `:3183` and `:3212` credit WeakAuras2. [TREE] | **AMBER.** The author relicensed the file to zlib, but it states that some routines were taken and modified from GPLv2 code. Whether that relicensing was effective is not determinable from the tree. See §4. |
| **`libs/LibDeflate/LICENSE.txt`** | An HTML copy of the **GNU LGPL v3**, which contradicts the zlib header in the `.lua`. Upstream's changelog says: "v1.0.2-release — Change the license to the zlib license (Formerly LGPLv3)". So the bundled LICENSE.txt is a stale file from before 1.0.2. Upstream's current `LICENSE.txt` is zlib. [TREE] + [WEB https://raw.githubusercontent.com/SafeteeWoW/LibDeflate/main/changelog.md and …/LICENSE.txt, 2026-11-16] | AMBER (documentation inconsistency). |
| **`CptStadicsVendorTreasures.lua:1-5`** (630 lines) | Header: "Cpt. Stadics' Vendor Treasures / Derived from https://www.curseforge.com/wow/addons/cpt-stadics-map-of-vendor-treasures / Creative Commons Attribution-NonCommercial 3.0 Unported". Embedded in `6e0de427` "Embed Cpt. Stadics' Vendor Treasures (#177)" (SabreValkyrn, 2023-06-03). **Loaded on Forever**: `RXPGuides.toc:119 [AllowLoadGameType vanilla,camelot,tbc,wrath]`, and the guard at `:9` (`if build > 40000 … return`) does not exclude build 16001. [TREE] The CurseForge page lists the licence as "Creative Commons Attribution-NonCommercial 3.0 Unported", author Stadics, with no separate reuse statement. [WEB https://www.curseforge.com/wow/addons/cpt-stadics-map-of-vendor-treasures, 2026-11-16] | **AMBER.** Not GPL, but a different licence (BY-NC 3.0, no ShareAlike) inside a BY-NC-SA 4.0 project. Its attribution terms must be carried, and the mix needs Don's decision. |

### 2d. Mere mentions (no derivation)
- `mangos`, `cmangos`, `vmangos`, `trinity`, `azerothcore`, `classicdb`, `SimGear`, `pfquest`, `zygor`, `joana`, `guidelime`, `warcraftdb`, `all rights reserved`: **[NF]**. Zero hits in the tree outside our docs.
- `Questie` in guide text: `Guides/Classic-Horde-12-22_Barrens.lua:4463, 11863`, `Guides/forever/Horde-12-22_Barrens.lua:3464`, `Guides/forever/dungeon/Horde-12-22_Barrens.lua:3894`, `Guides/SurvivalGuide/H-Classic-Horde-15-23_Barrens.lua:3141`, `Guides/tbc/H-20-30.lua:5815`, `Guides/tbc/H-Hardcore-20-30.lua:4009`, and the `lang/*` copies. All of them are the warning "turn off any autocomplete functions from addons such as Questie or Leatrix Plus". Locale strings appear in `locale/*.lua` and `Scripts/new_locale.lua:687-688, 861`. [TREE]
- `wowhead`: `ItemUpgrades.lua:881` (comment URL to a wowhead filter page), `Talents.lua:1292` (comment URL), `Guides/SoD/Warlock.lua:138` and 5 `lang/` copies ("--Wowhead npc 3203 also possible"). These are reference comments. They show that upstream authors consulted Wowhead but do not show copied text. [TREE]
- `wago`: `.github/workflows/package.yml:15` (`WAGO_API_TOKEN`), TOC `X-Wago-ID`, `Guides/Retail/.../Jade Forest.lua:1331` (`.link https://wago.io/DSKFme0-p`). These relate to distribution, plus one link. [TREE]
- `Icy Veins`: spell names only (`Guides/SoD/Mage.lua:1127`, `Guides/Talents/*-mage.lua`). [TREE]
- `licen[cs]e` in guides: WoW quest names ("License Not Required", "Artistic License"). `functions.lua:6932`: "Flight Master's license" spell. [TREE]
- `copyright` in `Textures/DarkMode/CLASS_ICONS.psd`: the embedded sRGB ICC profile string "Copyright (c) 1998 Hewlett-Packard Company". This is a standard false positive. [TREE]
- `WeakAuras` in `RXPGuides.lua:123-125`: a runtime `WeakAuras.ScanEvents` call (interop). [TREE]
- `TomTom`, `SilverDragon`, `TotemTimers`, `Leatrix Maps` in `Help.lua:35-41`: compatibility help strings. [TREE]

## 3. Bundled data provenance

| File(s) | What the evidence says | Strength |
|---|---|---|
| `Scripts/UiMap.1.15.9.69722.csv`, `Scripts/UiMapAssignment.1.15.9.69722.csv` | Columns `Name_lang,ID` and `Region_0,Region_1,Region_3,Region_4,UiMapID,MapID`, with the client build `1.15.9.69722` in the filename. This is the naming used for client DB2 table exports (UiMap.db2 / UiMapAssignment.db2), in the style of a wago.tools CSV export [GK on the export tool]. Consumed by `Scripts/coordinateTransform.py` (`7e3231ba` "Coordinate conversion script", Zarant, 2026-09-25). Source: **Blizzard client data**, not GPL. Excluded from packages by `.pkgmeta`. | Strong (structure + build number) [TREE] |
| `Scripts/dangerous_dump.py` → `DB/classic/dangerousMobs.lua`, `DB/forever/dangerousMobs.lua` (about 320 KB each) | The script reads `'Hardcore dangerous mobs - Alliance.csv'` / `'… - Horde.csv'` (sheet-export filenames, not in tree) with columns `Name,Zone,Level,Classification,Movement,Notes/Abilities,Commands` and writes Lua (`dangerous_dump.py:1-60`). Commits `82e79ccd` "Add dangerous mobs (#172)" (incl. "Update Horde Tsona data"), `900f4a32`, `30920f1a`. Records are in RXP's own DSL (`.line`, `.mob`, `.pin`, `.unitscan`). The spreadsheet's authorship is not stated. **No sign of Questie or MaNGOS origin** (no spawn tables, no GUIDs, and the schema is RXP's own). | Medium. Origin is an unattributed spreadsheet, probably RXP-internal. [TREE] |
| `Scripts/stat_weights.py` → `DB/*/StatWeights.lua` (about 324 KB) | Reads `./Scripts/Values leveling - * Classic Era.csv` / `TBC` / `Cataclysm` (sheet exports, not in tree). Commits `2fea7e2e` "Add Item Upgrades v1 (#188)" and `44c029ae` "Add Tactics ItemUpgrades stats v2 (#228)". Tactics is an upstream contributor (`Tacticslol`). These are hand-authored weights in RXP's own schema. | Medium. RXP-authored spreadsheet. [TREE] |
| `DB/*/flightData.lua` (`addon.FPDB`: taxi node ID → {dest node: seconds, name}) | `ee2f9cc3` "added flight timers" (2022-07-03). `DB/forever` adds `7cd3b2fc` "Forever update" and `22e6ce26` "Added forever FP data" (Forever nodes such as `[3203] "Rog'mar, Riverglades"`). The shape (measured flight seconds keyed by TaxiNodes IDs) points to in-game timing. No source statement. | Weak–medium (structure only). [TREE] |
| `DB/mop/db.lua:925` `addon.taxiPos` (wx, wy, flag) | Comment: "See TaxiNodes dbc table for reference". Client data. Same shape in `DB/mainline/db.lua:960`. | Strong for the source type. [TREE] |
| `DB/classic/SpiritHealerDB.lua`, `DB/forever/SpiritHealerDB.lua` | World coordinates `wx, wy` per graveyard. Header comment: "Spirit Healer Locations continent, id, posx, posy, locname". Added via external PR `4a1e5f0f` "Spirit healer imp (#314)" (ReyHey, 2025-09-30). The commit messages state no source. World-coordinate graveyard tables exist both in client data (WorldSafeLocs) and in server emulator DBs [GK]. The tree does not show which source was used. | **Unknown.** Low volume (about 115 rows). Flag for Don. [TREE] |
| `DB/*/rares.lua` (classic/forever) | Plain rare-name lists per zone (`"Fedfennel", "Gruff Swiftbite", …`). Commits `bd3f4483` "Add rares scanning (#127)", `03211d35` "Add Dredd rare data to Classic (#142)" (Dredd = contributor in log), `aa89a741` localisation. Facts (names) only. `DB/forever/rares.lua:8` returns early on `gameVersion >= 11508`. | Medium. Contributor-supplied. [TREE] |
| `DB/mop/rares.lua` | **Copied from HandyNotes – Pandaria Treasures (GPLv3)**. See §2c. | Strong (self-declared). |
| `DB/*/quest.lua`, `DB/shared.lua`, `DB/*/spells.lua`, `DB/*/db.lua` | Hand-maintained small tables (`skipPreReq`, `questCompleteItems` with comments "Quest // Item", trainer spell IDs by level, rep thresholds, guide lists). Early history: `dff60460` "generic spell training" (2021-05-14), `c4bcc519` "db restructure". No source statement. No Questie schema (§2 search). | Weak–medium. Looks hand-authored. [TREE] |
| `DB/questDB.lua` | **Logic only** (1,824 lines). The quest DB itself is built at runtime from the guides. Questie use is runtime-only (§2a, §2b). | Strong. [TREE] |
| `locale/NPCnames.lua` (33,937 lines; enUS → deDE/esES/frFR/koKR/… NPC names) | `877a294a` "Added localized NPC names", `8f49def3` "npc localization". No source stated. These are Blizzard's localised names (facts), but the tree does not record how they were compiled (in-game, client DB, or a database site). | Unknown. [TREE] |
| `libs/HereBeDragons/HereBeDragons-2.0.lua:99` | "map transform data extracted from UIMapAssignment.db2 (see HereBeDragons-Scripts on GitHub)". Client data. | Strong. [TREE] |
| `Guides/**`, `lang/Guides-*/**` | Guide text authored by RestedXP staff and contributors (`translation-bot` produced 138 commits for `lang/`). Comments occasionally cite Wowhead as a reference (§2d). | — [TREE] |

**Overall for §3.** I found no evidence that any shipped data file was converted from Questie, QuestieDB or a MaNGOS-family dataset, after searching the source names in §2, Questie's schema field names, and the commit messages of the files above. The single confirmed GPL-derived data file is `DB/mop/rares.lua`, which comes from a HandyNotes addon. Provenance is **unrecorded** for `SpiritHealerDB.lua`, `locale/NPCnames.lua`, the dangerous-mobs spreadsheet, and flight times.

## 4. Embedded libraries

Version = the MINOR or `$Id` stated in the file. "Bundled licence" = what the files in `libs/` say.

| Library | Version in file | Licence in bundled files | Published licence | Flag |
|---|---|---|---|---|
| LibStub | `LIBSTUB_MINOR = 2` (`LibStub.lua:3`) | `LibStub.lua:2`: "LibStub is hereby placed in the Public Domain" | Public domain [TREE] | OK |
| CallbackHandler-1.0 | MINOR 8, `$Id … 1298 2022-12-12` | none | Part of Ace3 → "Ace3 Style BSD" (see Ace3) [WEB wowace ace3, 2026-11-16]; that it is part of Ace3 is [GK] | OK, notice needed |
| Ace3: AceAddon (13), AceComm (14), AceConfig (3), AceConfigCmd (14), AceConfigDialog (92; `mainline/` copy 93), AceConfigRegistry (22), AceConsole (7), AceDB (36), AceDBOptions (15), AceEvent (4), AceGUI (41) + widgets, AceLocale (6), AceSerializer (5) | e.g. `AceAddon-3.0.lua:31` `$Id … 1284 2022-09-25` | **none** (no LICENSE.txt bundled) | WowAce: "Ace3 Style BSD" [WEB https://www.wowace.com/projects/ace3, 2026-11-16]. Repo `LICENSE.txt`: "Copyright (c) 2007, Ace3 Development Team. All rights reserved. Redistribution and use … permitted provided that … Redistributions of source code must retain the above copyright notice … **Redistribution of a stand alone version is strictly prohibited without prior written authorization** …" [WEB https://raw.githubusercontent.com/WoWUIDev/Ace3/master/LICENSE.txt, 2026-11-16] | OK for embedding, which is not stand-alone. **Notice obligation is currently unmet**: the copyright notice and conditions are not in the tree. "All rights reserved" here is the usual BSD preamble, not a bar. |
| ChatThrottleLib (in AceComm) | `CTL_VERSION = 32` | `ChatThrottleLib.lua:23`: "LICENSE: ChatThrottleLib is released into the Public Domain" | Public domain [TREE] | OK |
| HereBeDragons | `HereBeDragons.toc:9` "2.18-release"; HBD-2.0 MINOR 35, Pins MINOR 17, Migrate 2 | `HereBeDragons.toc:7`: `## X-License: BSD` | WowAce: "BSD License" [WEB https://www.wowace.com/projects/herebedragons, 2026-11-16]. The GitHub repo has no LICENSE file (API `license: null`) [WEB api.github.com, 2026-11-16] | OK. Exact BSD text not published; keep the TOC line and credit Nevcairiel. |
| LibCandyBar-3.0 | MINOR 104 (`:24`) | none | WowAce: "Ace3 Style BSD" [WEB https://www.wowace.com/projects/libcandybar-3-0, 2026-11-16] | OK, notice needed |
| LibDBIcon-1.0 | `DBICON10_MINOR = 52` | none | WowAce: "Ace3 Style BSD" [WEB https://www.wowace.com/projects/15552, 2026-11-16] | OK, notice needed |
| **LibDataBroker-1.1** | MINOR 4 (`:5`) | none | WowAce licence field: **"All Rights Reserved"** [WEB https://www.wowace.com/projects/libdatabroker-1-1, 2026-11-16]. The GitHub repo `tekkub/libdatabroker-1-1` has no licence file or statement (only `LibDataBroker-1.1.lua`, `README.textile`) [WEB api.github.com, 2026-11-16] | **AMBER.** No published grant of redistribution. It is in practice embedded in thousands of addons [GK], but no licence could be confirmed. Used only for the minimap button (`SettingsPanel.lua:7, 3705`). |
| **LibDeflate** | "1.0.2-release" (`:2`, `:95`), MINOR 3 | `.lua`: "@license zlib License" (`:9`, full text `:31-49`). **`LICENSE.txt` = LGPLv3** (stale) | GitHub: SPDX **Zlib** [WEB api.github.com/repos/SafeteeWoW/LibDeflate, 2026-11-16]. Changelog: 1.0.0 GPLv3 → 1.0.1 LGPLv3 → 1.0.2 zlib [WEB changelog.md, 2026-11-16] | **AMBER.** (a) The stale LGPL file contradicts the header. (b) Parts are self-declared as modified from GPLv2 LibCompress and WeakAuras2 (§2c). Used by the import/encoding paths (`GuideLoader.lua:16, 454, 473, 900-926`; `GuideWindow.lua:8, 3169-3218`). |
| **LibUIDropDownMenu-4.0** (`libs/mainline/`) | `$Id … 135 2024-02-05 arithmandar`; `LibEasyMenu.lua` `$Id … 64 2020-11-18` | none | **GPL (v2)**. See §2c [WEB https://www.wowace.com/projects/libuidropdownmenu; https://www.wowace.com/project/268264/license, 2026-11-16] | **RED.** GPL code loaded on Forever via `embeds_Mainline.xml`. Concern: GPLv2 is copyleft and CC names no GPL compatibility for BY-NC-SA 4.0. Shipping it inside a BY-NC-SA package conflicts with the "No GPL" hard rule. The library is also a fork of Blizzard's FrameXML `UIDropDownMenu` [GK]. |
| plc (base64 only) | no version; `base64.lua:3` "Copyright (c) 2015 Phil Leblanc -- see LICENSE file" | `libs/plc/LICENSE`: MIT ("Permission is hereby granted, free of charge…"; © 2018 Phil Leblanc, © 2017 Pierre Chapuis) | GitHub SPDX **MIT** [WEB api.github.com/repos/philanc/plc, 2026-11-16] | OK. The file was modified by RXP (`base64.lua:1-2` adds `local _,addon = ...`; `:56` `addon.read = decode`). Commit `211c16c7` "changed b64 lib". MIT notice is kept. |
| `libs/compatibility.lua` | — | none | RestedXP's own (only author Zarant: `3b8a0cec`, `d55b8d87`) [TREE] | OK (upstream CC BY-NC-SA) |

Libraries whose published licence I **could not confirm** as a redistribution grant: **LibDataBroker-1.1** ("All Rights Reserved" on WowAce, nothing on GitHub). HereBeDragons' exact BSD wording is not published (only "BSD").

## 5. Textures and other assets

- No licence or origin statement exists for any asset. `Textures/` holds about 270 files: `.blp`, 2 `.tga`, 2 `.png`, and 1 `.psd`. No sound or font files are bundled (searched `ttf|otf|ogg|mp3|wav`). [TREE]
- **RestedXP branding (rebrand question):** `Textures/rxp_logo-64.blp`, `rxp_logo-128.blp`, `rxp-banner.blp`, `rxp_alliance-64.blp`, `rxp_horde-64.blp`, `rxp_cog-32/64.blp`, `rxp-borders.blp`, `rxp-btn-blank-32.blp`, `rxp-checked-32.blp`, `rxp_navigation_arrow-1.blp`. The same set is duplicated in `Textures/DarkMode/`, `Textures/GoldAssistant/`, `Textures/Green/`, `Textures/Hardcore/`. In `Textures/v2/` there are `rxp-icon-logo.blp`, `rxp-minimap-icon.blp`, `rxp-header-texture.blp`, `rxp-icon-affiliate.blp`, and about 100 more `rxp-icon-*.blp`. There is also `Textures/v2/rxp-icon-affiliate.blp`, which may relate to shop or affiliate UI. Branding text appears in the TOC `## Title: RestedXP Guides` and `## Author: RestedXP`. [TREE]
- **Possibly third-party or Blizzard-derived art** (by name and purpose only, no origin data): the class icon sets (`Textures/{,DarkMode/,GoldAssistant/,Green/,Hardcore/}{DEATHKNIGHT,DRUID,…,WARRIOR}.blp`) and the source file `Textures/DarkMode/CLASS_ICONS.psd`. The PSD's XMP says "created 2022-09-08, Adobe Photoshop CS6, converted from image/png" and gives no author. `Textures/v2/rxp-icon-{druid,hunter,mage,…,demonhunter,monk}.blp`, `rxp-icon-{mc,ony,bwl,tbc,wrath,mop,vanilla}.blp` (raid and expansion emblems) and `fp.blp` may imitate Blizzard iconography. I could not determine this from the files. [TREE; resemblance is an inference]
- Runtime references to Blizzard's own textures (for example `Interface/GossipFrame/VendorGossipIcon.blp` in `CptStadicsVendorTreasures.lua:28`, `Interface\\MINIMAP\\Minimap_skull_normal` in `DB/mop/rares.lua`) are paths into the client and are not bundled. [TREE]

## 6. RestedXP's own terms

| Page | Result |
|---|---|
| https://www.restedxp.com/create-your-own-restedxp-guide/ (linked from `readme.md`) | **Could not fetch.** HTTP 403 via both WebFetch and curl (2026-11-16). I did not reconstruct it. |
| https://www.restedxp.com/terms-of-service/, `/terms-and-conditions/`, `/` | HTTP 403 (2026-11-16). `/terms/` returned 200, but it is the JS shell of the home page with no terms text. |
| Site JS bundle `https://www.restedxp.com/main-4NFHC7BX.js` (2026-11-16) | Footer strings: `COPYRIGHT: "RXP MEDIA LLC. ALL RIGHTS RESERVED."`, `TRADEMARKS: "All trademarks referenced herein are the properties of their respective owners."`, `AFFILIATION: "RestedXP is not affiliated with or endorsed by Blizzard Entertainment, Inc."`. Terms link → `https://shop.restedxp.com/terms-conditions/`; privacy → `https://shop.restedxp.com/privacy-policy/`. Social links include `github: https://github.com/RestedXP`. [WEB] |
| https://shop.restedxp.com/terms-conditions/ (the actual T&C) | **Could not read.** Both curl and WebFetch hit a "Waiting Room powered by Cloudflare" queue page (2026-11-16). The Wayback Machine could not be fetched from this environment. **The terms remain unread. PIPELINE §7 is still open.** |
| https://community.restedxp.com/custom-guides (fetched 2026-11-16) | "Create Your Own Guides using RestedXP … **Rested XP is a free open source addon and offers you the possibility to create your own leveling routes.** Our documentation shows you how." Page footer: "Copyright 2021 - All Right Reserved". It links a template `https://community.restedxp.com/wp-content/uploads/2025/08/RXPGuides_Template.zip` (not downloaded) and a Google Sheet of documentation. **No statement** about forking, redistribution, trademark use, or ownership of user-made guides was present in the text. [WEB] |
| https://community.restedxp.com/community-guides (fetched 2026-11-16) | Describes community-written guides ("submit it for verification, and upon approval, it will be showcased"). Footer: "©2025 RXP MEDIA LLC. ALL RIGHTS RESERVED. All trademarks referenced herein are the properties of their respective owners." No reuse or fork terms. [WEB] |

Facts usable from this: the rights holder's entity name appears to be **RXP MEDIA LLC** [WEB]. RestedXP itself calls the addon "free open source" [WEB]. "RestedXP" is used as a brand name, but **no trademark-specific statement was found**.

## 7. Paid-content / obfuscation check

Searches run:
- (a) Every tracked file for runs of 200 or more base64-like characters (`[A-Za-z0-9+/=_()-]{200,}`). The only hit was `Textures/blur_box.blp` (binary).
- (b) `premium|encrypt|decrypt|cipher|salsa|xor|obfusc|paid|purchas|restedxp.com|shop.` in non-guide Lua, XML and TOC files.
- (c) `#premium|#paid|groupOrContent` in `Guides/` and `lang/`.

Findings:
- **No encrypted or encoded guide payloads in the tree.** The `Guides/` (22 MB) and `lang/` (93 MB) files are plain-text RXP DSL. [TREE] I did not compare the public guide text against RestedXP's paid products, because I have no access to them.
- **The paid-guide decryption and import path is present** (CLAUDE.md requires removing or disabling it):
  - `GuideLoader.lua:380-470` `CheckDataIntegrity`: an RC4-style keystream (`S[i], S[j]` swap; `bitxor(..., S[(S[i]+S[j]) & 0xff])` at `:418-423`) over base64-decoded import strings, then zlib decompression, then an Adler-32 check. On failure it reports "Account mismatch, import string does not apply to current account".
  - `GuideLoader.lua:590-640` `addon.ReadCacheData` derives the key from `select(2, _G[addon.DeserializeTable(addon.base)]())`.
  - `addon.base = {66,78,71,101,116,73,110,102,111}` is the ASCII codes for **"BNGetInfo"**, so the key is derived from the player's BattleTag. This function name is written as a byte array (mild obfuscation) in `DB/shared.lua:37`, `DB/cata/db.lua:293`, `DB/mop/db.lua:533`, `DB/tbc/db.lua:278`, `DB/wotlk/db.lua:309`. `DB/shared.lua` loads on Forever (`DB/forever.xml`).
  - Callers: `GuideLoader.lua:814-827` (`RXPString` SavedVariable auto-import), `:1444`, `:1533` `ImportString`, `UI/V2/GuideImporter.lua:563`.
  - Cached guides are stored deflate-compressed in SavedVariables (`GuideLoader.lua:473, 900-926`).
  
  All of this is readable code, but it exists to unlock account-bound paid content. [TREE]
- Possible shop or affiliate UI asset: `Textures/v2/rxp-icon-affiliate.blp`. I did not trace its usage. [TREE]

## 8. Facts a NOTICE.md needs

1. Upstream: **RestedXP Guides (RXPGuides)**, https://github.com/RestedXP/RXPGuides. TOC author "RestedXP". Rights holder per restedxp.com footer: "RXP MEDIA LLC" [WEB, 2026-11-16]. Main upstream authors by commit count: Zarant, SabreValkyrn, yamanlol, Thiddi, Shiekrunner, tommysalamiwow, and about 25 others. [TREE]
2. Upstream licence: **CC BY-NC-SA 4.0**, `LICENSE` added 2023-12-29 (`3b9212eb`). Licence URI: https://creativecommons.org/licenses/by-nc-sa/4.0/.
3. Forked at upstream commit **`22e6ce26e2855ec730d50d40f8a7d5cd733a7327`** (2026-11-14, "Added forever FP data").
4. Statement that files have been modified, with an indication of what changed (CC BY-NC-SA 4.0 §3(a)(1)(B)), and that the adaptation is licensed under CC BY-NC-SA 4.0 (§3(b)).
5. Disclaimer that the fork is not affiliated with or endorsed by RestedXP / RXP MEDIA LLC or Blizzard (the licence's no-endorsement condition, §3(a)(1)(A)(i) and §2(a)(6)). The RestedXP name and logos are not licensed as trademarks (§2(b)(2) excludes trademark rights).
6. Third-party notices, if the components are kept:
   - Ace3 + CallbackHandler (Ace3 BSD-style, with the full copyright line and conditions).
   - LibCandyBar-3.0 and LibDBIcon-1.0 (Ace3 Style BSD).
   - HereBeDragons (BSD, Nevcairiel).
   - LibStub and ChatThrottleLib (public domain).
   - plc base64 (MIT, Phil Leblanc, modified).
   - LibDeflate (zlib, Haoqian He; altered versions must be marked).
   - LibDataBroker-1.1 (licence unconfirmed).
   - LibUIDropDownMenu (GPL, if not removed).
   - Cpt. Stadics' Vendor Treasures (CC BY-NC 3.0, author Stadics, source URL, changes indicated).
   - HandyNotes – Pandaria Treasures (GPLv3, if not removed).
7. No reuse terms from restedxp.com could be recorded, because the T&C page was unreadable (§6).

---

## Items for Don to decide

| Item | Evidence | Risk as I see it | Options |
|---|---|---|---|
| `DB/mop/rares.lua` copied from GPLv3 HandyNotes – Pandaria Treasures | `DB/mop/rares.lua:3` "Taken from …"; CurseForge licence GPLv3 (2026-11-16) | Direct breach of the "No GPL data, ever" rule if kept in the repo. Not loaded on Forever. | Delete with the rest of MoP in P1 (DESIGN §3 strip); record the removal. |
| LibUIDropDownMenu (GPLv2) loaded on Forever | `RXPGuides.toc:26` → `libs/embeds_Mainline.xml`; `RXPGuides.lua:2773`; wowace licence page "The GNU General Public License (GPL)" | GPL code inside the CC BY-NC-SA package on the target flavour | Remove it and use the client's own `UIDropDownMenu` / `MenuUtil` (the code already prefers `_G.CloseDropDownMenus`); or replace it with own code; or accept it with a separate-licence notice (conflicts with the hard rule). |
| LibDeflate: GPLv2-derived routines + stale LGPLv3 LICENSE.txt | `LibDeflate.lua:64-72, 2856-2860, 3114-3118, 3183`; `libs/LibDeflate/LICENSE.txt` | Author relicensed to zlib. Inherited GPLv2 fragments make the provenance unclear. The stale file misstates the licence. | Replace with `C_EncodingUtil` (already preferred in `GuideLoader.lua:397-460`); or remove it with the import path; or keep it, replace LICENSE.txt with upstream zlib text, and note the history. |
| Cpt. Stadics' Vendor Treasures (CC BY-NC 3.0) loaded on Forever | `CptStadicsVendorTreasures.lua:1-5`; `RXPGuides.toc:119`; CurseForge licence (2026-11-16) | Not GPL, but a separate licence with attribution duties. Embedded data is Classic-era vendor content of uncertain use on Forever. | Drop the module (it is optional and off-topic for v1); or keep it with full BY-NC 3.0 attribution in NOTICE. |
| LibDataBroker-1.1: no confirmed licence | WowAce "All Rights Reserved"; GitHub no licence | Formally no redistribution grant (de facto ubiquitous) | Drop the LDB minimap button and use a plain frame or LibDBIcon alternative; or keep it and record it as unconfirmed. |
| Paid-guide decrypt/import path (RC4, BattleTag key, `addon.base` = "BNGetInfo") | `GuideLoader.lua:380-470, 590-640, 814-827, 1444, 1533`; `DB/shared.lua:37`; `UI/V2/GuideImporter.lua` | Required by CLAUDE.md to be removed or disabled. The byte-array function name is obfuscation. | Remove in P1 (strip). Keep plain-text guide import only if wanted. |
| restedxp.com terms unread | §6. The T&C sits behind a Cloudflare queue. The guide article returns 403. | PIPELINE §7 cannot be closed | Don reads https://shop.restedxp.com/terms-conditions/ and the guide article in a browser and pastes the relevant text; or asks RestedXP directly. |
| RestedXP branding assets and name | §5 file list; TOC Title/Author | Trademark/endorsement (licence §2(b)(2), §3(a)(1)(A)(i)) | Replace in the P1 rebrand; keep credit text only. |
| Unrecorded provenance of some data | `DB/*/SpiritHealerDB.lua` (external PR #314), `locale/NPCnames.lua`, dangerous-mobs spreadsheet, flight times | No evidence of GPL origin, but no positive source either | Accept as upstream (CC BY-NC-SA) with `provenance: upstream`; or re-derive the Forever subsets from `/wf dump`. |
| Pre-2023 code with no licence file, about 30 contributors | `3b9212eb` 2023-12-29 vs first commit 2021-04-09 | Upstream's own concern; we rely on their licensing | Note it only. |
| Questie debug export tool | `DB/questDB.lua:836-890` | No shipped data shows Questie zone fields. The tool remains dormant. | Remove it in our fork to avoid any temptation; keep runtime interop (§2a), which is allowed. |

## What could not be checked

- RestedXP T&C and the guide-creation article (blocked: 403 / Cloudflare queue; Wayback not reachable).
- The source spreadsheets for dangerous mobs and stat weights (not in tree).
- Whether the public guides overlap RestedXP's paid guides (paid guides not available).
- The visual origin of `.blp` textures (no tool to render BLP here; judged by name only).
- The full Questie licence was not re-verified. CLAUDE.md records it as GPL-3.0, confirmed 2026-11-15.
