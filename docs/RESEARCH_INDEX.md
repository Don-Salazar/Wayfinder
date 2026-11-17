# RESEARCH_INDEX.md — what the research workbook holds and how far to trust it

Workbook: "WoW: Forever Addon — Verified Information"
(https://claude.ai/artifact/4stuB1hLzdXoawxLJdHxDJ), snapshot 2026-11-15.
Don downloads it as `.xlsx` into `docs/research/verified.xlsx`; the first
tooling task converts each tab to CSV and Markdown under `docs/research/`.

## Status labels used in the workbook

| Label | Meaning | May ship? |
|---|---|---|
| Primary source | Blizzard, a licence text, or source code read directly | Yes, as a rule or a fact |
| Secondary source | Two or more independent sources agree | As a fact; IDs still need the game |
| Single source | One source only (most Wowhead data) | No. Seed only, until the dump or a recording confirms it |
| Conflicting | Sources disagree; both values recorded | No. Resolve in game |
| Unverified / Test in client | Not found, or a claim to test | No |
| Confirmed in game | Don or a self-test confirmed it | Yes |

## Tabs

| Tab | Rows | What it is | Main source | Feeds |
|---|---|---|---|---|
| Facts | 254 | Every finding with status, source, date | Mixed | Everything; read it first |
| Decisions | 8 | Product decisions Don made | Don | DESIGN |
| Checks | 12 | Things to test in the client | Us | SelfTest |
| Gaps | 21 | Open research gaps | Us | OPEN_QUESTIONS |
| Route | — | Horde zone order notes by level band | Guides, creators | Guide authoring |
| Flight paths | 33 | Horde flight masters with coordinates | Guides | Guide steps |
| XP table | 59 | XP per level 1–60 | One guide | Pace maths |
| Hotfix log | 28 | Blizzard hotfixes to 12 Nov | Blizzard, mirrors | Staleness checks |
| Zone IDs | 30 | Wowhead area IDs for Forever zones and dungeons | Wowhead | Lookups only (not UiMapIDs) |
| Riverglades quests | 105 | Horde-doable quests: ID, level, required level, XP, type | Wowhead | P5 guide seed |
| Shen'dralas quests | 43 | All quests; 19 have no faction flag | Wowhead | P5 guide seed |
| Quest rewards | 34 | Riverglades and Shen'dralas rewards with stats | Wowhead | Gear hunts seed |
| Dungeons | 9 | Entrance, access, bosses, quests per new dungeon | Guides, Wowhead | Dungeon detours |
| Dungeon loot | 79 | Krol'dok, Alcaz, Blackmaw items with stats and source | Wowhead | Gear hunts seed |
| Loot and POIs | 56 | Rare loot and must-visit points | Guides, videos | Optional steps |
| Camp objects | — | Camping objects and buffs | Guides | Optional steps |
| Legacy perks | — | Legacy system perks | Guides | Talent timing |
| Class quests | 10 | Warrior class quests | Guides | Class layer |
| Trainers | — | Trainer notes | Guides | Train steps |
| Warrior abilities | 18 | Abilities by level 1–50 | Two guides | Class layer |
| Ability numbers | 41 | Warrior per-rank damage, duration, cooldown | Wowhead tooltips + guides | Tooltips, macros |
| Spell IDs | 108 | Warrior: spell ID, learn level, trainer cost per rank | Wowhead | Train steps, macros |
| Talents | 55 | Warrior talents: ranks, values, tier | Guides + Wowhead | Talent prompts |
| Troll Warrior build | 51 | Level-by-level build, training and gear targets, 10–60 | Published path to 40; our design after | Talent prompts, first slice |
| Macros | 14 | Warrior macro ideas, all untested | Videos, guides | Macros module (rewrite bodies ourselves) |
| Class abilities | 359 | Eight other classes: spell IDs, learn levels, trainer costs by rank | Wowhead | Train steps, macros (P7) |
| Class talents | 414 | Eight other classes: tree, tier, max ranks, spell ID | Wowhead | Talent prompts (P7) |
| Class overview | 9 | Per class: Blizzard changes, leveling spec, class quests, hotfixes | Blizzard, Method | Class layers (P7) |
| Race class matrix | 10 | Race, faction, classes, starting zone | Two sources | Route selection |
| Racials, Races | 38 / 10 | Racial abilities with spell IDs; race notes | Three sources | Macros, tips |

## Known weaknesses

- **Wowhead is one source and lags hotfixes.** Examples: Defiance shows 15%
  (live is 20%), Mental Dexterity shows its pre-10 Nov value. Its
  changed/removed flags are unreliable (Defensive Stance is flagged removed).
  Talent text shows one rank only and sometimes renders a value as 0.
- **Wowhead's drop lists are still filling in.** Blackmaw Hold gained two
  items between 13 and 14 Nov. The Shaper's Terrace has no data at all.
- **No costs.** No source publishes mana, energy or rage costs.
- **No played Horde 30–60 route exists** in any written or video source as of
  15 Nov. Three research passes found none.

## Open items only the game can answer (the dump and recorder target list)

1. Rage, mana and energy cost of every ability rank
   (`C_Spell.GetSpellPowerCost`).
2. Disputed Warrior values: Demoralizing Shout rank 5 (196, 204 or 210),
   Bloodthrill, crit rage bonus (double or 75% more), Whirlwind cost.
3. Race base stats for all ten race variants, starting with Troll Warrior.
4. UiMapIDs for Riverglades, Shen'dralas, Zephras Isle and the nine dungeons.
5. Quest givers, turn-in NPCs, coordinates and chain order for Riverglades
   and Shen'dralas.
6. Faction of the 19 unflagged Shen'dralas quests and the unflagged dungeon
   quests in Alcaz Prison and Blackmaw Hold.
7. Boss order in Alcaz Prison (two guides disagree) and Blackmaw Hold
   (unpublished); everything about The Shaper's Terrace.
8. Whether the Krol'dok Compound Key is needed, and what it opens.
9. Hearthstone cooldown; whether flight paths are learned by visiting.
10. Trainer contents: confirm spell IDs, learn levels and prices per rank, and
    whether Toughness and Improved Cleave are trainer spells.
11. Shaman Call of the Ancestors / Spirits levels; whether Lightwell and Lava
    Burst exist.
12. Macro command support: `/castsequence`, `/equipslot`, `#showtooltip`,
    stance conditionals.
13. A played Horde route for 30–60, with XP per hour by segment.
