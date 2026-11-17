# UPSTREAM_MAP.md — how the upstream engine works

What this is: a map of RestedXP's RXPGuides source as it stands at the commit
we forked from, written by reading the source. It is the reference for every
later phase: guide authoring (Part A) and the rebrand, strip and new modules
(Part B).

| | |
|---|---|
| Upstream commit | `22e6ce26e2855ec730d50d40f8a7d5cd733a7327` (see `docs/UPSTREAM.md`) |
| Read on | 2026-11-16 |
| Engine state | Unmodified upstream |
| Review | Checked against the source by separate agents with fresh context; results in § Review record at the end |

## How to read it

- Every citation is `file:line` in the checkout at the commit above. Paths
  are relative to the repo root. Line numbers go stale when upstream changes
  a file; re-check after each sync.
- **Inferred** marks a conclusion drawn from reading code, not something the
  code states.
- **Verified (harness)** marks a function or pattern copied verbatim from the
  source and run under the project-local Lua 5.1 with stubbed WoW globals.
- Nothing here has been tested in the game client. Sections A11 and B17 list
  what only the client can answer.

## Vocabulary

- **guide**: one `RegisterGuide([[...]])` call; a header plus steps.
- **group / subgroup**: the menu folders a guide is listed under.
- **step**: a block starting with a line that begins `step`.
- **element**: one line inside a step that the parser turns into a table
  (a `.function` line, a `+` line, a `*` line or a `>>` line).
- **step tag**: a `#tag value` line inside a step; stored as `step[tag]`.
- **header tag**: a `#tag value` line before the first step; stored as
  `guide[tag]`.

## Contents

**Part A — guide DSL, loader, step engine, navigation**

- A1. Guide file anatomy
- A2. Guide header tags
- A3. Conditions (`<<`)
- A4. Step syntax
- A5. Element functions (`.tag`)
- A6. Loader pipeline
- A7. Step engine
- A8. Navigation
- A9. Forever-specific branches in the DSL/engine files
- A10. How upstream's Forever guides are organised
- A11. Could not determine / needs the game client

**Part B — load order, detection, saved variables, settings, comms, import, data, modules, hooks**

- B1. Load order on Forever (`camelot`)
- B2. Forever detection
- B3. Embedded libraries loaded on Forever
- B4. Saved variables
- B5. Global footprint
- B6. Guide files ↔ globals (collision analysis)
- B7. Guide import and encryption
- B8. Commercial and outbound elements
- B9. Communications
- B10. Settings system
- B11. Module mechanism and hook points
- B12. Bundled data on Forever
- B13. ItemUpgrades and Talents on Forever
- B14. Questie interop
- B15. Locale system
- B16. Packaging
- B17. Could not determine / needs the game client
- B18. Conflicts with this project's rules

---

# Part A — guide DSL, loader, step engine, navigation

## A1. Guide file anatomy

A guide file is plain Lua. It registers one or more guides by calling the
global `RXPGuides.RegisterGuide` with a long string.

- `_G.RXPGuides` is created at `RXPGuides.lua:223-225`.
- `RegisterGuide` and `ImportGuide` are exported onto it at
  `GuideLoader.lua:1389-1394`.
- `addon.RegisterGuide(groupOrContent, text, defaultFor)` is at
  `GuideLoader.lua:522-539`. Upstream guide files call it with one argument
  (the whole guide text). With a second `text` argument the first argument
  is the group name and the header pre-scan is skipped (`GuideLoader.lua:657`).
- Several guides in one file are simply several `RegisterGuide` calls.
  `Guides/forever/Horde-01-12_Durotar.lua` holds four (at lines 5, 1100,
  3185, 3819).

Real excerpt, `Guides/forever/Horde-01-12_Durotar.lua:1-24` (abridged to the
lines shown):

```lua
local faction = UnitFactionGroup("player")
if faction == "Alliance" then return end

local L = GetLocale() if L and RXP.enabledLocale[L] then return end
RXPGuides.RegisterGuide([[
#forever
#disabledungeons
<< Horde
#name 1-6 Durotar
#version 11
#group RestedXP Forever Guide (H)
#subgroup Speedrun Guide 1-22
--#groupid RXP-SRGCE-H1
#defaultfor Troll/Orc
#next 6-10 Durotar

step << !Orc !Troll
    #completewith next
    +|cRXP_WARN_You have selected a guide meant for Orcs and Trolls. ...|r
step
    .goto 1411/1,-4251.46,-607.35
    >>|Tinterface/worldmap/chatbubble_64grey.blp:20|tTalk to |cRXP_FRIENDLY_Kaltunk|r
    .accept 4641 >>Accept Your Place In The World
    .target Kaltunk
```

Points a guide author must know:

1. **File-level Lua guards.** Upstream files return early for the other
   faction (`Horde-01-12_Durotar.lua:1-2`) and when the client locale has its
   own translated guide set: `RXP.enabledLocale[L]` (`Horde-01-12_Durotar.lua:4`).
   `RXP` is a global alias of the addon table set at `RXPGuides.lua:2771`
   ("debug purposes"); `addon.enabledLocale` is at `RXPGuides.lua:171-183`
   (enUS = false; deDE, esES, esMX, frFR, ptBR, zhCN = true; zhCN is set
   to the same value again for FOREVER at `RXPGuides.lua:207`). The
   translated copies live under `lang/Guides-<locale>/`.
2. **Comments.** `--` to end of line is stripped everywhere in the guide
   text, including inside display text (`GuideLoader.lua:1106`, `:1134`,
   pre-scan `:668`). Upstream uses this for inline notes such as
   `.goto 1421/0,1593.60,597.91,15,0--c:Silverpine Forest,44.20,38.17`
   (`Guides/forever/Horde-01-14_Undead.lua:3740`). A literal `--` can
   therefore never appear in guide text. Two exceptions in the parser
   (the pre-scan strips to end of line unconditionally):
   - The parser's pattern is `%-%-[^\r\n]*[\r\n]+`, which needs a line end
     after the comment. A comment on the very last line of the guide
     string, with no newline after it, is not removed
     (`GuideLoader.lua:1106`, `:1134`).
   - Text that starts with a `--<digits>` length marker (the stored form
     of imported guides, A6.3) is not comment-stripped at all
     (`GuideLoader.lua:1101-1109`).
3. **Header** = every line before the first line that starts with `step`.
   **Steps** follow. Leading and trailing whitespace on each line is
   trimmed (`GuideLoader.lua:1160-1161`); empty lines are skipped by the
   line iterator (`GuideLoader.lua:1158`). A line that holds only spaces
   or tabs is not empty to the iterator (`[^\n\r]+`): it is visited,
   counted in `linenumber` (`:1159`) and then ignored, so it shifts the
   `stepId` of every later step (A4.1).
4. A guide **must** have `#name` and `#group`. What happens without them
   depends on which is missing (as read from `ParseGuide`):
   - No `#group` line (one-argument form, no group passed in by the
     caller): `ParseGuide` writes "Invalid guide group" through
     `addon.comms.PrettyDebug`, which prints only in debug mode, and
     returns `nil` before any line is parsed
     (`GuideLoader.lua:1125-1131`). The `"#0"` branch is not reached.
   - No `#name` line: at the first `step` line the parser raises a Lua
     error only if `addon.currentGuideName` is still `nil`
     (`GuideLoader.lua:1164-1166`). That field is addon-wide and is left
     set by any earlier guide (`:1242`; also `GuideWindow.lua:1954`,
     `Tips.lua:426`), so in practice only the first guide parsed in a
     session can raise it. Otherwise `hasGuideMetadata` fails
     (`guide.group` is preset at `:1144`, so only a missing name can make
     it fail) and the parser returns error code `"#0"`; the guide is
     dropped (`GuideLoader.lua:1172-1177`, `:1182-1189`).
   - The Lua error at `GuideLoader.lua:1252` is reached only by a guide
     that has no `#name` and no `step` line at all.

---

## A2. Guide header tags

### A2.1 How header lines are parsed

`ParseGuide` handles header lines at `GuideLoader.lua:1216-1247`:

- A line of the form `<< condition` (nothing before `<<`) sets
  `guide.enabledFor` and, if the condition fails for this character, marks
  the guide skipped (`GuideLoader.lua:1218-1223`). With several bare
  `<< condition` lines the two results diverge: the **last** such line
  decides whether the guide is skipped (`skipGuide = not isValid and tag`
  is reassigned each time, so a later passing line cancels an earlier
  failing one, `:1221`), while `guide.enabledFor` keeps the **first**
  (`:1222`). The pre-scan (A2.3 rule 4) uses only the first. Write one
  bare `<<` line per guide.
- A line `#tag value << condition` is dropped when the condition fails,
  otherwise the condition is removed (`GuideLoader.lua:1224-1227`).
- `#tag value` stores `guide[tag] = value` (value may be empty, giving `""`,
  which is truthy in Lua). **Only the first applicable occurrence of a tag
  is kept** (`not guide[tag]`, `GuideLoader.lua:1234`). This is how
  conditional alternatives work: list `#next A << X` then `#next B << Y`.
- `#tag = funcName` stores the result of calling `addon.functions[funcName]()`
  (or the literal value if no such function) (`GuideLoader.lua:1235-1237`).
  No guide file in this checkout uses the `=` form.
- `#group X << cond` lines are pre-filtered before any other parsing
  (`GuideLoader.lua:1111-1120`) so a guide can sit in different groups per
  faction (used by `Guides/forever/RestedXP-Skyborne.lua:10-11`).
- `#name` also sets `addon.currentGuideName` for error messages
  (`GuideLoader.lua:1241-1243`).

**The parser accepts any `#tag`.** There is no whitelist: a misspelt tag is
stored and silently ignored. The checkout contains such misspellings in
guide files: `#sofcore`, `#completwith`, `#completewtih`, `#requies`,
`#require`, `#sesaon`, `#oder` (counts from a search of `Guides/` for
`^\s*#[a-zA-Z]+`). A linter is the only protection.

### A2.2 Header tags that the engine reads

The table lists every header tag for which a reader exists in engine code
(search of `*.lua` and `UI/V2/*.lua` for `guide.<tag>`-style reads). Tags
read only by the Talents DSL are listed separately in A2.4.

| Tag | Argument | Effect | Read at |
|---|---|---|---|
| `#name` | text | Guide name. A leading `D-DD` range is zero-padded for sorting (`1-6 Durotar` becomes `01-06 Durotar`; verified (harness)); `displayname` defaults to the unpadded name. | `GuideLoader.lua:1241`, `:1292-1293`; `addon.affix` `:108-111` |
| `#group` | text, optionally `<< cond` | Menu group. Leading `+` makes a farm guide (`guide.farm`, `GuideLoader.lua:1138-1141`). A leading `*` puts the group in the unused/low-priority list: the menu builder sorts groups by first character into farm, normal and unused lists (`GuideWindow.lua:2476-2487`). The loader itself writes that prefix for demoted guides (`GuideLoader.lua:703`, `:921`, `:1274`, `:1280`, `:1285`) and strips it again for display (`:196`). | Group string chosen at `GuideLoader.lua:1111-1132`, `:1144` |
| `#subgroup` | text | Sub-folder inside the group; part of the guide key. | `GuideLoader.lua:264-289`; key `:797-805` |
| `#displayname` | text | Name shown in menus and window. | `GuideLoader.lua:1292`; `GuideWindow.lua:1566-1580` |
| `#somname`, `#eraname` | text | Name shown when season is SoM (`season == 1`) / not SoM. | `GuideWindow.lua:1573-1576` |
| `#title` | text | Window title override (else displayname + subgroup). | `GuideWindow.lua:1963-1977` |
| `#version` | number | `tonumber(version) or 0`; tracked in `addon.min/maxGuideVersion`; used by comms and import (Part B). | `GuideLoader.lua:1296-1298`, `:142-150` |
| `#next` | `name` or `group\name`, several separated by `;` | Guide loaded when the last step completes. First listed guide that exists **and** is active wins; zero-padding is applied to the name. See A6.5. | `functions.lua:3863-3972` |
| `#defaultfor` | condition (A3 grammar) | If the condition fails, the guide is moved to the low-priority list `*<group>` (hidden unless "show unused guides"). Special value `58Boost` (level 58-59 only). | `GuideLoader.lua:1254`, `:1275-1290`; `:702`; `:920` |
| `#forever`, `#classic`, `#tbc`, `#wotlk`, `#cata`, `#df`, `#retail` | none | Game-version tags; see A2.3. `#df` sets `guide.retail` (`GuideLoader.lua:1168`). `#mop` is matched by `guide[game]` but is **not** in the "has a game tag" list. | `GuideLoader.lua:1168-1177`, pre-scan `:676-681` |
| `#hardcore`, `#softcore` | none | Hardcore-mode guide pairing. On any game other than CLASSIC the loader forces `hardcore = nil, softcore = true` when the guide is loaded. | `GuideWindow.lua:1865-1878`, `:1908-1911`; `GuideLoader.lua:294` |
| `#disabledungeons` | none | All `.dungeon` steps of this guide are hidden unless a `.enabledungeon` override exists for the group. | `RXPGuides.lua:2731-2738` |
| `#include` | `group\name` | Guide-level include: steps of another guide are spliced in front. | `GuideWindow.lua:1644-1665`, `:1762` |
| `#loop` | none | After the last step, jump back to step 1 instead of chaining. | `GuideWindow.lua:768-775` |
| `#internal` | none | Guide is never listed or loaded directly (only via include/chapters). | `GuideWindow.lua:1845`, `:2436` |
| `#disabled` | none | Guide is shown greyed (menu title) and cannot be loaded. | `GuideLoader.lua:293`; `GuideWindow.lua:1845`, `:2573`, `:2589` |
| `#chapter` | none | Guide is hidden from group listing (shown only through a parent's `#chapters`). | `GuideLoader.lua:216`, `:226` |
| `#chapters` | `name;name;...` | Sub-menu of chapter guides. | `GuideWindow.lua:2504-2531` |
| `#groupid` | id | Lookup by group id; CLASSIC group renaming. (All Forever guides comment it out with `--`.) | `GuideLoader.lua:223-231`, `:1328-1337` |
| `#groupweight` | number | Sort weight of the group in the menu. | `GuideLoader.lua:178`; sort `GuideWindow.lua:2489-2496` |
| `#subweight` | number | Sort weight of the subgroup. | `GuideLoader.lua:271-285` |
| `#groupdisplayname` | text | Display name for the group (also set internally by `GroupOverride`). | `GuideLoader.lua:163-172` |
| `#theme` | theme name | Applies a window theme on load. | `GuideWindow.lua:1914`; `Themes.lua:146-160` |
| `#hidewindow` | none | Guide hides the step window (used by the empty guide). | `GuideWindow.lua:409`, `:2386` |
| `#disablecaching` | none | Guide is parsed eagerly by the background cache loop. | `RXPGuides.lua:2222` |
| `#standalone` | none | Read by the quest-log module. | `QuestLog.lua:203` |
| `#OnClick` | function name | Menu click calls `addon.functions[name](guide)` instead of loading. | `GuideWindow.lua:2466-2472` |
| `#guideKind`, `#guideIcon` | text | Read by the v2 configurator UI only. | `UI/V2/GuideConfigurator.lua:1563`, `:1664`, `:1705-1708` |
| `#season`, `#phase`, `#xprate`, `#fresh`, `#veteran`, `#maxlevel`, `#questguide`, `#speedrunguide`, `#beta`, `#era`, `#som`, `#era/som` | as the step tags in A4 | `IsGuideActive` runs the step filters on the guide table, so these hide a whole guide. | `GuideWindow.lua:2433-2449` (exported at `:2457`) |

Internal guide fields that are **not** header tags but share the namespace
(an author who writes `#steps`, `#key`, `#labels`, `#lowPrio`, `#enabledFor`
etc. would collide with them): `steps`, `key`, `guideId`, `labels`,
`lowPrio`, `enabledFor`, `defaultFor`, `farm`, `imported`, `empty`,
`tips`, `questConversion`, `mirrorID`, `disabledQuests`, `menuIndex`,
`submenuIndex`, `boost58`, `parse`, `length` (set at `GuideLoader.lua:1140`,
`:1188-1192`, `:1222`, `:1274`, `:1288`; `GuideWindow.lua:1639-1640`,
`:1981`; `functions.lua:1369-1376`, `:7811-7815`, `:7844-7848`).
`defaultFor` (capital F) is written only on the cached metadata table
(`GuideLoader.lua:1312`) and by `DB/questDB.lua:1406-1420`; a parsed
guide carries the header tag as `guide.defaultfor` (lower case).

### A2.3 How a guide is accepted or rejected for the running game

1. **Game detection.** `addon.game` is set from the interface number
   `select(4, GetBuildInfo())` (`RXPGuides.lua:168`): `"FOREVER"` when
   `16000 <= gameVersion < 20000` (`RXPGuides.lua:204-207`), `"CLASSIC"`
   below 16000. **It does not use `WOW_PROJECT_ID`.**
   `WOW_PROJECT_CAMELOT` appears in non-guide Lua at `functions.lua:259`
   (icon set), `RXPGuides.lua:585` (trainer purchase order), a commented
   block at `RXPGuides.lua:1397-1400`, `Targeting.lua:243` (tested
   together with `WOW_PROJECT_MAINLINE`; the file is loaded per
   `RXPGuides.toc:53`) and the bundled library
   `libs/HereBeDragons/HereBeDragons-2.0.lua:19` (see A8.1). None of
   these sets `addon.game`.
2. **Which files run at all** is decided by the TOC
   (`Guides/GuideList-forever.xml [AllowLoadGameType camelot]`,
   `RXPGuides.toc:66`; details in Part B).
3. **Queueing.** `addon.addonLoaded` is assigned in only two places: `false`
   at the end of `OnInitialize` (`RXPGuides.lua:1653`) and `true` in
   `OnEnable` (`:1660`). `RegisterGuide` parses immediately only when the
   flag is `true`, or when it is `false`, a settings profile is loaded
   and either `preLoadData` is on or the realm is not hardcore; in every
   other case, including `nil`, it queues the raw text in
   `embeddedGuides` (`GuideLoader.lua:525-538`). So a guide file that runs
   before `OnInitialize` is queued. That guide files run before
   `OnInitialize` is client load-order behaviour (the TOC lists the guide
   lists, and the addon's initialisation callbacks fire after its files
   have run); it is inferred here, not confirmed from source, and is
   settled by the in-game dump showing the guide list.
4. **Header pre-scan** (`LoadGuide`, `GuideLoader.lua:648-698`), applied to
   queued one-argument guides (`not guideData.text`, `:657`) in which the
   pattern `[\r\n]%s*step` finds a first step (`:659-661`): the text
   before that point is scanned line by line. A header line is first
   dropped if its own `<< cond` fails (`:669-675`). The guide is
   **enabled only if some header line, uppercased, contains `#` ..
   `addon.game`** — i.e. `#FOREVER` on Forever — or `#DF` on RETAIL, or
   `#FOREVER` on CLASSIC (`:676-681`). This is a substring search on the
   whole uppercased line, so it is looser than the parser, which needs
   the lower-case tag `#forever` at the start of a line to set
   `guide.forever` (`:1171`, `:1231-1234`). Then the first bare
   `<< cond` header line must apply (`:683`, `:688`); the first `#group`,
   `#subgroup` and `#name` lines are the ones kept (`:684-686`).
   Rejected guides are recorded by **queue position**, not by name:
   `RXPCData.guideDisabled[n] = length` (`:694`), and the next pass skips
   entry `n` whenever that slot is set, without comparing the length
   (`:655`). See A6.2 step 6 for when that table is reset.
5. **Parse-time check** (`ParseGuide`, `GuideLoader.lua:1167-1177`), applied
   at the first step: `hasGameTag` = any of classic/tbc/wotlk/df/retail/cata/forever;
   `isGameCompatible = guide[strlower(addon.game)] or (FOREVER and guide.classic) or (CLASSIC and guide.forever)`.
   A guide with a game tag that is not compatible returns `"#0"` and is not
   added.
6. **Low priority.** On CLASSIC, a `#forever` guide without `#classic` is
   demoted to `*<group>` (`GuideLoader.lua:1272-1274`, `:702`, `:920`). There
   is no mirror rule for FOREVER.

Consequences for Forever (inferred from 4 and 5 together; untested in
client):

- An upstream file guide needs a `#forever` header line to load on Forever.
- `ParseGuide` alone would accept a `#classic`-only guide on Forever, but
  queued file guides never reach it because the pre-scan requires
  `#FOREVER`. The `#classic`-only files that `GuideList-forever.xml` lists
  contain no `#forever` anywhere (search of the twelve
  `Guides/SurvivalGuide/*.lua` files, `Guides/Classic-Attunements.lua`
  with 11 guides and `Guides/Classic-0.5.lua` with 4 guides: zero
  matches, case-insensitive). From source they are therefore dropped by
  the pre-scan on Forever. This rests on two things only the client can
  show: that `addon.game` is `"FOREVER"` (A11 item 1) and that guide
  files run before `OnInitialize` (rule 3).
  Imported guides and guides registered with the two-argument form skip the
  pre-scan and would be accepted by rule 5.
- `#forever << Horde`-style lines work because the condition is evaluated
  before the game-tag search (`GuideLoader.lua:669-681`).

### A2.4 Tags read only by the Talents DSL

`#minLevel`, `#maxLevel`, `#order`, `#levelRange`, `#pet`, `#audit`,
`#description` are read in `Talents.lua` (e.g. `:82-86`, `:93`, `:146-154`,
`:453-455`, `:542-599`). Talent guides (`Guides/Talents/classic.xml`, loaded
on camelot per `RXPGuides.toc:115`) use their own parser and their own
function table (`addon.talents.functions`, `Talents.lua:619`, `:709`). That
DSL is not covered here.

### A2.5 Header tags present in guide files with no reader

Found in guide files but no engine read site was found: `#ah` (read only at
step level, see A4), `#map`, `#icon`, `#level` (step level only),
`#guideIcon` outside v2 UI, `#scryer`, `#aldor` (step level only),
`#reset`, `#timer`, `#subzoneskip`, `#hidearrow`, `#EndIncludePrepGuide`,
`#phase` (step level and via `IsGuideActive`), `#level20` (2 uses),
`#minlevel` (1 use, lower-case; the Talents reader in A2.4 is
`#minLevel`). The list is not exhaustive. Treat any tag not in A2.2 or
A4 as having no effect.

---

## A3. Conditions (`<<`)

### A3.1 Grammar

Implemented by `applies(textEntry, customClass, func)` at
`GuideLoader.lua:36-103`; exported as `addon.applies` (`:105`). The
grammar rules and the examples below were checked by running the function
verbatim under Lua 5.1 with stubbed globals for a level-1 Troll Warrior
on FOREVER (harness; untested in client). Statements marked "as read" or
"inferred" come from reading the code only.

- **Tokens** are runs of letters/digits: `!?[%w%d]+` (`:52`). Anything else
  (spaces, hyphens, apostrophes) separates tokens.
- **AND**: tokens separated by spaces inside one alternative must all match
  (`:52-84`).
- **OR**: alternatives separated by `/` (`:50`).
- **NOT**: a token prefixed with `!` (`:55-58`).
- **Parentheses**: `(...)` and `!(...)` are evaluated first and replaced by a
  token that is always true (the player's class token) or always false
  (`NULL`) (`:41-47`). The replacement is inserted with no padding, so a
  group written directly against a neighbouring word fuses with it into
  one token: for a Troll Warrior `(Warrior/Mage)Troll` becomes
  `WARRIORTroll`, which matches nothing, while `(Warrior/Mage) Troll` is
  true (as read from `:41-52`). Keep a space on both sides of a
  parenthesis group. The match is lazy (`.-`), so nested parentheses are
  not reliably supported: the first `(` is paired with the first `)`.
  Some nestings happen to give the right answer, others do not
  (inferred). Do not nest.
- **Only true results are cached.** The cache test is
  `if not aCache[textEntry]` (`:93-100`), so a stored `false` is treated
  as missing and the condition is evaluated again on every call, while a
  stored `true` is returned for the rest of the session. Consequences
  (as read; untested in client):
  - A condition that was true once stays true until the next `/reload`,
    even if it would now be false. The practical case is a negated level
    condition: `!10` evaluated at level 9 keeps answering true after the
    character reaches level 10.
  - A condition that was false is re-evaluated, so `10` turns true when
    the character reaches level 10, wherever the condition is evaluated
    again (see A3.3).
  - The cache key ignores `customClass` and `func`. The second and third
    calls at `GuideWindow.lua:2443-2445` therefore return the first
    call's result only when that first call returned true.

Examples (verified (harness), Troll Warrior, level 1, FOREVER):
`Horde` true; `Troll/Orc` true; `Troll Warrior` true; `warrior` true;
`troll` false; `!Hunter !Shaman !Tauren !Skyborne !Undead` true;
`Orc Hunter/Troll Hunter` false; `(Warrior/Mage) Troll` true; `10` false;
`1` true; `Forever` true; `DF` false.

### A3.2 Keywords

A token is true if **any** of these holds (`GuideLoader.lua:78-80`):

| Keyword kind | Spelling | Compared with | Notes |
|---|---|---|---|
| Class | case-insensitive class file token (`Warrior`, `WARRIOR`, `DeathKnight`); alias `DK` | `strupper(token) == class` (`UnitClass` 2nd return, `RXPGuides.lua:242`) | `:60`, `:63-64` |
| Race | race file token, **case-sensitive** (`Troll`, `Orc`, `Tauren`, `NightElf`, `Scourge`) | `token == race` (`UnitRace` 2nd return, `RXPGuides.lua:243`) | `Undead` is rewritten to `Scourge` (`:61-62`); `Haranir` to `Harronir` (`:74-75`). `Skyborne` is used by Forever guides as if it were a race token (e.g. `Guides/forever/RestedXP-Skyborne.lua:15`); the real token must be read in game. |
| Faction | `Horde`, `Alliance` (case-sensitive) | `UnitFactionGroup` | For a Neutral character both are treated as true unless `customClass` is passed (`:72-73`). |
| Level | a number `N` | `UnitLevel("player") >= N` | Read from `UnitLevel` at the moment of evaluation (`:49`). A true result is cached for the session, a false one is not (A3.1); inside a parsed guide the outcome is fixed at parse time (A3.3). |
| Game | `Classic`, `TBC`, `WOTLK`, `CATA`, `MOP`, `RETAIL`, `FOREVER` (case-insensitive) | `strupper(token) == addon.game` | `DF` is rewritten to `entry = "RETAIL"` but the comparison uses `uppercase` (still `DF`), so `<< DF` never matches (`:70-71`, `:79`; verified (harness)). |
| Season of Discovery | `SoD` (case-insensitive) | true when `addon.player.season == 2` | `:68-69` |
| Gender | `Male`, `Female` | `UnitSex` 2 / 3 | `:65-67` |
| Locale | `enUS`, `deDE`, … | `GetLocale()` | `:9`, `:79` |
| Custom class | any | `customClass` argument | only when a caller passes it |
| Custom check | any | `func(entry, uppercase)` | only `DB/questDB.lua:222` passes one |

There are **no** condition keywords for professions, dungeons, settings or
play style. Those are handled by step tags and element functions (A4, A5:
`.dungeon`, `.enabledungeon`, `.profession`, `.group`, `.solo`, `#ssf`,
`#ah`, `#xprate`, `#season`, `#phase`).

### A3.3 Where conditions are evaluated

Step and line conditions are evaluated **when the guide is parsed**; the
result is baked into the parsed guide (a failing step or line is simply
not there). A level condition on a step or line therefore reflects the
level when the guide was parsed (inferred from the call sites below;
guides are parsed at load or first fetch).

Guide-level conditions are also evaluated outside parsing. The bare
`<<` line (`enabledFor`) and `#defaultfor` are evaluated again each time
cached metadata is loaded (`GuideLoader.lua:702`, `:708`, `:887-888`,
`:920`), `enabledFor` again in `IsGuideActive` for a faction-neutral
character whenever the menu or `#next` asks (`GuideWindow.lua:2443-2445`),
and `#defaultfor` again by the v2 configurator when it picks a
recommendation (`UI/V2/GuideConfigurator.lua:1614`, `:1641`). `applies` is
also used on non-guide data in `Tips.lua:434` and `DB/questDB.lua:222`.
Because only true results are cached (A3.1), the answer for a given
condition string can change during a session only from false to true.

| Position | Effect | Evaluated at |
|---|---|---|
| Guide header, bare `<< cond` line | Whole guide skipped; stored as `guide.enabledFor` | `GuideLoader.lua:1218-1223`; pre-scan `:683`, `:688`; cached guides `:887-888` |
| Header tag line `#tag v << cond` | That tag line ignored | `GuideLoader.lua:1224-1227`; pre-scan `:669-675`; `#group` `:1111-1120` |
| `#defaultfor cond` | Guide demoted to low priority | `GuideLoader.lua:1283` |
| Step line `step << cond` | Whole step and all its lines skipped | `GuideLoader.lua:1195-1199` |
| Any line inside a step | That line ignored | `GuideLoader.lua:991-995` |

Inside a step, `<<` is stripped from the line **before** `>>` text is
extracted (`GuideLoader.lua:991-994` then `:1013`), so
`.accept <questId> >>Text << Warrior` works, and `<<` can never appear in display
text.

---

## A4. Step syntax

### A4.1 Delimiting

- A step starts at any line whose first four characters are `step`
  (`GuideLoader.lua:1163`), optionally followed by `<< cond`. All following
  lines until the next `step` line belong to it.
- Each step gets `stepId = linenumber + guide.guideId` where `linenumber`
  counts the lines the iterator visits after comment stripping (every
  non-empty line, including lines that hold only spaces or tabs, A1
  point 3) and `guideId = A32(key)` (an Adler-32-style hash)
  (`GuideLoader.lua:1158-1159`, `:1191-1192`, `:1207`, `A32` at
  `:552-587`). Editing a guide above a step changes its `stepId`
  (inferred). The `key` hashed here is the one the caller passed in, when
  there is one: for a queued file guide that is the pre-scan key, built
  from the group, an empty subgroup and the unpadded name (`:691`,
  `:724`, `:1191`); the guide's final key is rebuilt after parsing with
  the subgroup and the zero-padded name (`:1295`).
- A step that ends with no elements is given `hidewindow = true` when the
  next step starts (`GuideLoader.lua:1200-1202`), and `optional = true` when
  the guide is loaded (`GuideWindow.lua:1997-1999`).

### A4.2 Step-tag parsing

`parseLine`, `GuideLoader.lua:997-1009`: `#tag value` (or `#tag = func`)
stores `step[tag] = value` (or the function `addon.functions[func]`). First
occurrence wins (`not step[steptag]`). Any tag is accepted. Tag names are
`%S+`, so `#era/som` is one tag (`step["era/som"]`).

### A4.3 Step tags the engine reads

Visibility filters run through `addon.IsStepShown(step, ...)`
(`RXPGuides.lua:2552-2569`), which ANDs every function in `addon.stepLogic`
(`RXPGuides.lua:2492-2769`). It is called once per step when the guide is
loaded (`GuideWindow.lua:1684`), so a hidden step is removed from the loaded
guide, not just hidden.

| Tag | Argument | Effect | Read at |
|---|---|---|---|
| `#completewith` | `next` or a label | Step counts as complete when the named step (or the next one) is passed; also makes the step sticky. | `GuideWindow.lua:701-724`, `:2004` |
| `#sticky` | none | Step stays active alongside later steps until complete. | `GuideWindow.lua:738-741`, `:810-812`, `:846-883` |
| `#requires` | `label[;label...]` | The step only activates once every labelled step is no longer active/pending. This gates sticky steps (`:851-873`) and also the ordinary current step in `SetStep` (`:888-903`). At load, a required sticky step that has no `#completewith` of its own is given one pointing back at this step; that lookup uses the whole `#requires` string as a single label, so the back-link is made only when `#requires` names one label (`:2005-2015`). | `GuideWindow.lua:851-873`, `:888-903`, `:2005-2015` |
| `#label` | name | Names the step for `#completewith`, `#requires`, `@label` include ranges, `skipto`, `xp`/`skill` jumps. Stored in `guide.labels[label] = index`. | `GuideWindow.lua:2017` |
| `#optional` | none | Step hidden from the step list (still activated in turn). | `GuideWindow.lua:206` |
| `#hidewindow` | none | Step hidden from both step windows. | `GuideWindow.lua:204`, `:3128` |
| `#title` | text | Title shown instead of "Step N". | `GuideWindow.lua:1086-1089` |
| `#arrowtext` | text (`\n` allowed) | Text under the waypoint arrow. | `GuideWindow.lua:2000-2002`; `map.lua:152` |
| `#level` | number | Step is not activated (and shown hidden) below this level. | `GuideWindow.lua:2016`, `:875-876`, `:903`, `:2187` |
| `#include` | `group\name` or `name`, optional `@startLabel-stopLabel` | Splices the steps of another guide (or a label range of it) at this point. See A6.4. | `GuideWindow.lua:1644-1678`, `:1705`, `:1746` |
| `#loop` | none | Waypoints of this step are reset when the arrow is hidden (looping patrol). | `map.lua:1037`, `:1233-1247` |
| `#map` | zone name or UiMapID | Map used for this step's pins. | `map.lua:930` |
| `#icon` | `\|T...\|t` texture | Map pin icon. | `map.lua:203`, `:325` |
| `#ignorecorpse` | none | Corpse waypoint not injected for this step. | `map.lua:1066` |
| `#linethickness` | number | Line width for `.line`/`.loop` drawings. | `map.lua:773` |
| `#track` | quest id | Super-tracks that quest (`C_SuperTrack`) on activation. | `GuideWindow.lua:799-802` |
| `#stop` | none | Quest-log module stop point. | `QuestLog.lua:318-321` |
| `#qremove` | number | Quest-log module. | `QuestLog.lua:284` |
| `#xprate` | `A-B`, `<A`, `>A` | Shown only if the XP rate setting is in range. On FOREVER the rate is `profile.xprate or 1` (the CLASSIC season override does not apply). | `RXPGuides.lua:2636-2681` |
| `#season` | list of numbers (`0,1`) | Shown only if `profile.season` is in the list. | `RXPGuides.lua:2616-2623` |
| `#era`, `#som`, `#era/som` | none | Hidden in SoM (`season == 1`) / outside SoM / in SoM phase > 2. | `RXPGuides.lua:2611-2614` |
| `#phase` | `N` or `N-M` | Shown if the content phase is in range. A single number `N` means phase `N` **or later** (the upper bound defaults to `0xffff`, `RXPGuides.lua:2530-2537`), not exactly phase `N`. On FOREVER the phase is forced to 5 (`RXPGuides.lua:2520-2525`). | `RXPGuides.lua:2516-2546` |
| `#softcore`, `#hardcore` | none | Hidden in hardcore / outside hardcore mode. | `RXPGuides.lua:2628-2634` |
| `#softcoreserver`, `#hardcoreserver` | none | Hidden on / off a hardcore realm (`C_GameRules.IsHardcoreActive`). | `RXPGuides.lua:2630-2631` |
| `#ssf`, `#ah` | none | Hidden when solo-self-found is off / on. | `RXPGuides.lua:2579-2585` |
| `#questguide`, `#speedrunguide` | none | Loremaster-mode filter. On FOREVER loremaster is always false (only WOTLK/CATA branches set it, `RXPGuides.lua:2590-2595`), so `#questguide` steps are always hidden. | `RXPGuides.lua:2588-2601` |
| `#fresh`, `#veteran` | max level | Fresh/veteran account filter using `C_PlayerInfo.CanPlayerEnterChromieTime`. | `RXPGuides.lua:2683-2709` |
| `#maxlevel` | number | Hidden above this level when XP step skipping is enabled. | `RXPGuides.lua:2711-2717` |
| `#daily` | none | Hidden when dailies are skipped. | `RXPGuides.lua:2548-2550` |
| `#beta` | none | Hidden unless beta features are enabled. | `RXPGuides.lua:2764-2769` |
| `#aldor`, `#scryer` | none | TBC reputation filter; always true on CLASSIC/FOREVER. | `RXPGuides.lua:2494-2514` |
| `#disabled` | none | Step always hidden. | `RXPGuides.lua:2720` |
| `#group`, `#solo` | none | Group-quest filter (normally set by `.group` / `.solo`). | `RXPGuides.lua:2571-2577` |
| `#dungeon`, `#dungeonskip`, `#profession`, `#professionskip` | tag | Normally set by `.dungeon` / `.profession` (A5); dungeon and profession filters. | `RXPGuides.lua:2719-2762` |
| `#tip` | none | Turns the step into a "tip" shown in the tip window. No guide file uses it. | `GuideWindow.lua:727-733`, `:1732-1735` |

Fields the engine sets on steps at run time (do not use as tags): `index`,
`active`, `completed`, `elements`, `stepId`, `reqFulfilled`, `hidetip`,
`hiddentext`, `tipWindow`, `activeItems`, `activeSpells`, `activeMacros`,
`centerPins`, `frame`, `lastStep`, `text` (`GuideWindow.lua:2241-2244`),
`tooltipText` (`functions.lua:6010`), `isActive` (`Tips.lua:455`),
`missingTranslation` (`SettingsPanel.lua:4192`), plus Tips.lua's `rare`, `treasure`,
`dangerousMob`, `levelBuffer`, `showTooltip`, `mapTooltip`,
`alternateIcon`, `isUnitscan`, `hideMinimap` (`Tips.lua:449-490`).

Step tags found in guide files with no reader: `#reset`, `#timer`,
`#subzoneskip`, `#hidearrow`, `#EndIncludePrepGuide`, and the misspellings
in A2.1.

### A4.4 Lines inside a step

`parseLine`, `GuideLoader.lua:977-1087`. Order of processing:

1. `<< cond` stripped and checked (`:991-995`).
2. `#tag` handled as above (`:997-1009`).
3. `>> text` stripped; the rest of the line after `>>` becomes the
   element's display text (`:1013-1016`).
4. `.tag args` dispatched to `addon.functions[tag]` (A5) (`:1018-1050`).
   Arguments: split on commas, whitespace around commas removed, **empty
   fields dropped** (`[^,]+`, `:1024-1027`), so a positional argument
   cannot be left blank. Per-tag argument splitters in `addon.separators`
   override this: `.link` and `.clicknext` take the rest of the line as one
   argument (`functions.lua:4792-4797`); `.unitscan`, `.target`, `.mob`
   split on `;` (`functions.lua:4922-4931`). The function's return value
   becomes the element; `parseLine` then sets `element.tag` to the tag
   as written, overwriting any tag the function itself set
   (`GuideLoader.lua:1033`; for example `bindlocation` sets
   `element.tag = "home"` at `functions.lua:2720` and that is discarded).
   Unknown `.tag`: `addon.error` is called with "Invalid function call"
   (`GuideLoader.lua:1038-1049`). `addon.error` is not a Lua error; it
   only calls `addon.comms.PrettyDebug` (`functions.lua:282-293`), which
   prints nothing unless debug mode is on (`Communications.lua:432`). So
   a misspelt `.tag` is silent for a normal user, the same as a misspelt
   `#tag`, and a linter is the only reliable protection. The key test is
   `parsingLogic[tag]` (`GuideLoader.lua:1030`), so the two non-function
   keys of the table, `.events` and `.__index` (`functions.lua:105`,
   `:112`), pass the test and then fail on the call; a linter should
   reject them as tags.
5. If the line carried `>> text` and step 4 produced no element, the
   result is a text-only element showing that text (`:1052-1053`). This
   covers three cases: a line with only `>> text`; a `.tag ... >>text`
   line whose function returned `nil` or whose tag is unknown (the
   `return` at `:1032` leaves only the pattern callback, not
   `parseLine`), so the element is dropped but its text is still shown
   as a plain line; and a `+text >>more` line, which therefore does
   **not** create a checkbox: it becomes a text-only line showing `more`,
   because the `+` and `*` branches are `elseif` alternatives.
6. `+text` (with no `>>` on the line) → an objective element with a
   checkbox (manual tick) (`:1054-1056`).
7. `*text` (with no `>>` on the line) → text-only element without
   tooltip; `\n` becomes a newline (`:1057-1063`).
8. Any other line is ignored silently (no error branch is active,
   `:1064-1066`).

Parent linking: an element whose function returns `parent = true` is
attached to the last non-text-only element of the same step
(`addon.lastObjective`, `GuideLoader.lua:1035-1037`, `:1067-1069`). This is
how `.goto`, `.timer`, `.disablecheckbox`, `.skipto` and `+`-prefixed
`.target/.mob/.unitscan` (`functions.lua:4989-4993`, `:5011-5015`,
`:5033-5037`) bind to the line above them.

---

## A5. Element functions (`.tag`)

### A5.1 How they work

- All functions live in the single table `addon.functions`
  (`RXPGuides.lua:237`).
- Each function is **dual-mode**. At parse time it is called as
  `f(lineText, displayText, arg1, arg2, ...)` (`GuideLoader.lua:1031`): the
  first argument is a string, and the function returns an element table,
  or `nil` to drop the element. Dropping the element does not always
  drop the line: if the line has `>>text`, that text is still shown as a
  plain text-only line (A4.4 step 5). After the call `parseLine` sets
  `element.tag` to the tag as written (`GuideLoader.lua:1033`), so a tag
  assigned inside a function body has no effect. At run time the
  function is called with a frame or element table as `self`: once when
  the element is bound to the active-step frame, which happens when the
  step becomes active (`GuideWindow.lua:280-282`, called from `:1164`
  and, for the v2 window, `UI/V2/Core.lua:2897`); on each registered
  event (`GuideWindow.lua:253-269`); on a `"WindowUpdate"` refresh
  (`GuideWindow.lua:2205-2215`, `:2295-2306`); and on scheduled tasks
  (`"TaskUpdate"`, `RXPGuides.lua:2042-2049`).
- A `"WindowUpdate"` call reaches only elements of steps from the
  current step to eight steps ahead, plus elements flagged
  `keepUpdating` or `requestFromServer` (`GuideWindow.lua:2203-2216`,
  `:2292-2307`).
- Events come from `element.event` (set by the parse function) or
  `addon.functions.events[tag]` (`functions.lua:106-218` plus later
  `events.x = ...` lines). `"OnUpdate"` in the list means a per-frame
  OnUpdate script, outside the ticker (`GuideWindow.lua:284-303`). Only
  a few parse functions set `element.event`: `waypoint`
  (`functions.lua:2154`), `maxlevel` (`:5986`), `emote`, `openmap` and
  the `DB/questDB.lua` and `DB/forever/db.lua` functions noted in the
  table. A function with neither source of events is never called on a
  game event.
- Completion: a function calls `addon.SetElementComplete(self)`
  (`functions.lua:962-998`) to tick its element, or sets
  `step.completed = true; addon.updateSteps = true` to skip the whole step
  (the "skip condition" pattern used by `isOnQuest`, `itemcount`,
  `zoneskip`, `itemStat`, etc.).
- **When a skip condition is evaluated** depends on the function, and it
  decides whether a step can disappear while it is on screen:

  | Functions | Evaluated |
  |---|---|
  | `isQuestComplete`, `isQuestNotComplete`, `isOnQuest`, `isNotOnQuest`, `isQuestTurnedIn`, `isQuestAvailable` | Only when the step is activated. Their `events` entries are commented out (`functions.lua:197-202`), no parse function sets `element.event` (`:4338-4503`), and the skip test is guarded by `event ~= "WindowUpdate"` (`:4369`, `:4419`, `:4485`). A quest-log change while the step is showing does not re-run them. An author must therefore place these steps so that the quest state is already settled when the step is reached. These six tags account for 1,590 lines in `Guides/forever/`. |
  | `itemcount` | At activation and on every `"WindowUpdate"` while the step is active (no `events` entry, no guard; `functions.lua:6213-6251`). |
  | `bindlocation` | At activation, on the `home` events (`functions.lua:129`) and on `"WindowUpdate"` (`:2728-2735`). |
  | `zoneskip`, `subzoneskip`, `xp`, `maxlevel`, `itemStat`, `cooldown`, `aura` and the others with an Events entry in A5.3 | At activation and on their listed events; whether each also acts on `"WindowUpdate"` was not traced for every function. |
- Text-only elements (`textOnly = true`) never block step completion
  (`GuideWindow.lua:694`).

### A5.2 Count and search used

Searches over all `*.lua` files:

1. `grep -rnE "^\s*function addon\.functions\.[A-Za-z_][A-Za-z0-9_]*\s*\(" --include=*.lua .`
   → 176 hits (functions.lua 158, DB/questDB.lua 7, DB/classic/db.lua 5,
   DB/forever/db.lua 5, DB/tbc/db.lua 1).
2. `grep -rnE "addon\.functions(\.[A-Za-z_]+|\[[^]]+\])\s*=[^=]" --include=*.lua .`
   → 9 function assignments (`noop`, `label`, `acceptmultiple`,
   `turninmultiple`, `goto`, `groundgoto`, `flygoto`, `getTBCchapters`,
   `tbcWBF`) plus the non-function `__index` and `events`.
3. Aliases through another local name: none found besides the Talents
   table (`grep` for `functions\.X = function` / `function ...functions.X`).

On Forever the loaded set is `functions.lua` + `DB/questDB.lua` +
`DB/forever/db.lua` (`DB/forever.xml`). `scenario` is defined twice in
`functions.lua` inside `if addon.gameVersion >= 110000 ... else`
(`functions.lua:6505`, `:6597`); only the `else` branch (`:6611`) runs on
Forever. **Total distinct names resolvable as `.tag` on Forever: 178.**
Of these, about 20 are helpers (waypoint callbacks, value providers, menu
actions) rather than line elements; they are marked "helper".

`.talent`, `.pettalent` and `.chromieon` appear in guide files but are not
in `addon.functions`: the first two belong to the Talents DSL
(`Talents.lua:619`, `:709`); `.chromieon` (5 uses in
`Guides/Retail/Collectables/Lorewalking.lua`) has no definition.

Text argument: every function's second parameter is the `>>` text; the
"Arguments" column lists only the comma arguments after `.tag`.

### A5.3 Table

"Forever uses" = number of lines starting with that tag in `Guides/forever/`
(both normal and dungeon variants). Line numbers are `functions.lua` unless
another file is named. "Runtime not fully traced" means only the parse
branch and the events were read.

How far each row was checked against the source: the name, the "Defined
at" line, the Events citation and the use count were checked for every
row. The "Arguments" and "Meaning" columns were checked against the
function body for every tag that `Guides/forever/` uses (62 tags) and for
about 45 others; for some of these only the parse branch was read, and
the row then says "runtime not fully traced" or describes the parse
result only. For the remaining names, all with 0 Forever uses (the
Retail, Mists and Wrath helpers such as `daily*`, `questwaypoint`,
`questgoto`, `stable`, `tame`, `petfamily`, `areapoi*`, `spellmissing`,
`explore`, `blastedLands`, `questitemcount`, `retrieveitem`,
`exitvehicle`, `logout`, `countdown`, the waypoint callbacks, `dmf` to
`skyriding`, `collectmount`, `collecttoy`, `collectpet`, `tradeskill`,
`achievement*`, `isWorldQuest*`, `collectcurrency`, `multibox*`,
`openitem`, `isInScenario`, `enterScenario`, `neutralzonefinished`,
`beta`, `landfall` to `vale`, `isQuestOffered`, `skipOnQuest`,
`acceptmap`, `totalbagslots`, `turninconfig`, `setturninhs`,
`setturninroute`, `getTBCchapters`, `tbcWBF`), those two columns are
**not confirmed from source**: they were written from the signature and
a partial read. Read the function body before relying on one of them.

| Name | Arguments | Meaning | Events | Defined at | Forever uses / notes |
|---|---|---|---|---|---|
| noop | — | Does nothing; helper | — | 1011 | 0; helper |
| label | `name` | Registers the step as `addon.labels["*"..name]` for a `#include *name` path that is dead code (see A6.4) | — | 1015 | 0 |
| accept | `questId[,flags[,questId2]]` | Accept a quest; completes when on/turned in. Flag 1 = no auto-accept; flag 2 = complete if `questId2` not turned in. `*quest*` in text → quest name. Uses QuestieDB prerequisites for a tooltip if Questie is installed (`functions.lua:493-495`, `:1240-1270`) | QUEST_ACCEPTED, QUEST_TURNED_IN, QUEST_REMOVED (119) | 1162 | 2446 |
| daily | `questId,questId,...` | Accept any of several (daily) quests | as accept (205) | 1315 | 0 |
| acceptmultiple | as daily | Alias of daily | as accept (207) | 1587 | 0 |
| disablequestautomation | `questId,...` | Parse-time only: adds IDs to `guide.disabledQuests` (no auto accept/turn-in) | — | 1365 | 0 |
| turnin | `questId[,reward[,flags]]` | Turn in a quest; reward = choice index; flag 1 = no auto turn-in. Negative ID = skip if missing (`skipIfMissing`); a negative ID together with a reward index above 0 also sets `skipIfIncomplete`, and the reward index is then discarded (1396-1404) | QUEST_TURNED_IN, QUEST_LOG_UPDATE, UNIT_QUEST_LOG_CHANGED (120) | 1382 | 2326 |
| dailyturnin | `questId,...` | Turn in any of several quests | as turnin (206) | 1537 | 0 |
| turninmultiple | as dailyturnin | Alias of dailyturnin | as turnin (208) | 1588 | 0 |
| complete | `questId,objIndex[,objMax[,flags]]` | Quest objective progress; flag 1 = text only; negative ID = skip if missing | QUEST_LOG_UPDATE, CINEMATIC_STOP, (STOP_MOVIE), UNIT_QUEST_LOG_CHANGED (121-125) | 1807 | 2127 |
| goto | `zone,x,y[,radius[,optional]]` | Waypoint arrow + map pin; see A8 | none (ticker) | 1917 | 13944 |
| groundgoto | as goto | goto skipped when the player can fly | ZONE_CHANGED (2019) | 2038 | 0 |
| flygoto | as goto | goto skipped when the player cannot fly | ZONE_CHANGED (2018) | 2043 | 0 |
| questwaypoint | `zone,x,y,radius,questId,objIndex[,objMax[,lowPrio]]` | Waypoint (no pin) tied to an objective's progress | QUEST_LOG_UPDATE, UNIT_QUEST_LOG_CHANGED (2071) | 2072 | 0 |
| questgoto | `zone,x,y,radius,questId,objIndex[,objMax[,optional]]` | goto tied to an objective's progress | as questwaypoint (2092) | 2093 | 0 |
| waypoint | Two forms: `zone,x,y[,radius[,lowPrio]]` (`lowPrio` numeric) or `zone,x,y,args,callback[,event...]` | Arrow waypoint without a map pin. When the fifth argument is not a number it is taken as a callback name: the fourth argument becomes `element.args` instead of the radius, and the remaining arguments become the element's event list (2150-2157; upstream usage comment at 6699-6703). There is no form with radius, `lowPrio` and a callback together. Zone forms as goto | — (callback form: the listed events, `element.event`, 2154) | 2113 | 256 |
| wpradius | `zone,x,y,radius` | Gives the previous waypoint an activation radius around a reference point | — | 2212 | 0 |
| pin | `zone,x,y[,tooltip]` | Map pin without arrow. Zone forms as goto (`mapId/instance` means world coordinates, 2250-2262) | — | 2239 | 86 |
| ingamewaypoint | `zone,x,y[,tooltip]` | Pin variant (in-game waypoint); runtime not fully traced | — | 2305 | 0 |
| treasure | `zone,x,y,questId` | Pin; dropped if the quest is turned in | QUEST_LOG_UPDATE, UNIT_QUEST_LOG_CHANGED (2396) | 2397 | 0 |
| rare | `zone,x,y,nameOrId` | Rare-mob pin; registers in `addon.rares` | CRITERIA_UPDATE (2426) | 2427 | 0 |
| line | `zone,x1,y1,x2,y2,...` | Draws a line on the map; `mapId/instance` zone means world coordinates. A leading `+` on the zone is meant to add a centre point, but the code that should strip it is `zone:sub(2-1)`, which strips nothing (2483-2487; verified (harness): `("+Zone"):sub(2-1)` returns `+Zone`). The zone lookup then fails for `+ZoneName`; `+<number>` still resolves because `tonumber` accepts a leading `+` (2512). Upstream bug as read; no Forever guide uses the `+` form | — | 2477 | 58 |
| loop | `range,zone,x1,y1,...` (`+`,`*`,`@` range prefixes) | Patrol loop drawn on the map with arrow cycling | — | 2530 | 0 (step tag `#loop` is used 421×) |
| hs | — (text required) | Use Hearthstone; completes on UNIT_SPELLCAST_SUCCEEDED of hearth spell IDs; adds the Hearthstone to the item bar | UNIT_SPELLCAST_SUCCEEDED (127) | 2581 | 82 |
| hsbatching | as hs | hs without the active-item window | as hs (2619) | 2620 | 0 |
| home | `[areaId]` | Set hearthstone; completes when bound | HEARTHSTONE_BOUND, CONFIRM_BINDER, GOSSIP_SHOW (128) | 2666 | 53 |
| bindlocation | `areaId[,flags]` | Step skip condition: skips the step when the hearthstone is bound to the area named by `areaId` (flag 1: when it is not). Compares `C_Map.GetAreaInfo(areaId)` with `GetBindLocation()` (2723, 2732); text-only | as home (129) | 2716 | 62 |
| fp | `location[,flags]` | Learn a flight path; FP looked up in `addon.FPDB` | UI_INFO_MESSAGE, UI_ERROR_MESSAGE, TAXIMAP_OPENED, GOSSIP_SHOW, TAXIMAP_CLOSED (126) | 2763 | 75 |
| fly | `location` | Take a flight; uses `UnitPosition` (2877) | PLAYER_CONTROL_LOST, TAXIMAP_OPENED, ZONE_CHANGED, GOSSIP_SHOW (130) | 2842 | 130 |
| deathskip | — | Die and resurrect at the spirit healer; also sets `step.softcore = true` (2926) | PLAYER_INTERACTION_MANAGER_FRAME_SHOW or CONFIRM_XP_LOSS, GOSSIP_SHOW (132-136) | 2916 | 82 |
| addquestitem | `itemId,questId` | Parse-time only: maps an item to a quest | — | 2951 | 4 |
| collectmultiple | `itemId` | collect with quantity 9999999 | as collect (114) | 2957 | 0 |
| collect | `itemId[,qty[,questId[,objFlags[,flags]]]]` | Item count objective; flags documented at 3014-3022 (1 no checkbox, 2 subtract from objective, 4 complete with objectives, 8 count bank, 16 ...) | BAG_UPDATE_DELAYED, QUEST_LOG_UPDATE, MERCHANT_SHOW, CHAT_MSG_LOOT, UNIT_QUEST_LOG_CHANGED (113) | 2994 | 1101 |
| destroy | `itemId` | Destroy an item; runtime not fully traced | as collect (115) | 3264 | 37 |
| xp | `[<]level[+xp\|-xp\|.frac][,skipstep[,label]]` | Reach a level/XP; with `skipstep` the step is skipped (or jumps to `label`) instead | PLAYER_XP_UPDATE, PLAYER_LEVEL_UP (139) | 3324 | 756 |
| skill | `skillName,[<]level[,skipstep[,useMax]]` | Profession/weapon skill threshold | SKILL_LINES_CHANGED, LEARNED_SPELL_IN_TAB (183) | 3448 | 257 |
| mountcount | `skill,[<>]=N` | Mount count check. **Returns nil when `gameVersion < 30000`** → no-op on Forever (3519-3520) | — | 3518 | 0 |
| maxskill | as skill | skill using max value | — (no `events` entry) | 3601 | 0 |
| reputation | `factionId,standing[+rep][,value[,skipStep]]` | Reputation threshold | UPDATE_FACTION (140) | 3605 | 0 |
| vendor | `[npcId]` | Visit a vendor | MERCHANT_SHOW, MERCHANT_CLOSED (141) | 3715 | 387 |
| trainer | `[npcId]` | Visit a trainer | TRAINER_SHOW, TRAINER_CLOSED (142) | 3741 | 269 |
| stable | `[npcId]` | Stable pet | PET_STABLE_SHOW, PET_STABLE_CLOSED (143) | 3766 | 0 |
| tame | `npcId` | Tame a beast | UNIT_SPELLCAST_SUCCEEDED, UNIT_SPELLCAST_START (144) | 3792 | 0 |
| money | `<gold` or `>gold[,useNetWorth]` | Money threshold (gold, ×1e4 copper) | PLAYER_MONEY (145) | 3821 | 437 |
| next | `[guide]` | Load the next guide (element form of `#next`); also the engine's chaining function | — | 3863 | 0 |
| train | `spellId[,flags]` | Learn a spell; flag 1 text-only, flag 2 reverse | TRAINER_SHOW, CHAT_MSG_SYSTEM, SKILL_LINES_CHANGED, TRAINER_UPDATE (146-148) | 3974 | 803 |
| hastyhearth | `[flag]` | train spell 83944 | — (no `events` entry) | 4045 | 0 |
| istrained | `spellId,...` | Text-only spell-known check | as train (149) | 4058 | 0 |
| abandon | `questId,...` | Abandon quests | as complete (196) | 4083 | 95 |
| petfamily | `family,...` (`!` negates) | Hunter pet family check | — | 4166 | 0 |
| areapoiexists | `zone,poiId,...` | Area POI present check | — | 4212 | 0 |
| areapoiguide | `zone,poiId,guide` | Area POI → guide | — | 4250 | 0 |
| questcount | `[<>]N[*],questId,...` | Count of quests on/turned in | as complete (4281) | 4282 | 0 |
| isQuestComplete | `questId[,account]` | Skip step unless quest complete; checked only at step activation (A5.1) | — (the entry at 198 is inside a block comment, 197-202) | 4338 | 363 |
| isQuestNotComplete | `questId[,account]` | Reverse of above | — (no `events` entry) | 4378 | 41 |
| isOnQuest | `questId,...` | Skip step unless on any listed quest; checked only at step activation (A5.1) | — (entry at 199 commented out) | 4385 | 702 |
| isNotOnQuest | `questId,...` | Reverse | — (no `events` entry) | 4428 | 52 |
| isQuestTurnedIn | `questId,...[,account]` | Skip step unless any quest turned in; checked only at step activation (A5.1) | — (entry at 200 commented out) | 4436 | 265 |
| isQuestAvailable | `questId,...` | Skip step if turned in; checked only at step activation (A5.1) | — (entry at 201 commented out) | 4498 | 167 |
| hideifcomplete | — | Hide the step from the list once complete | — | 4505 | 0 |
| spellmissing | `spellId` | Skip step if the spell is not known | as train (150) | 4517 | 0 |
| subzone | `areaId[,flags]` (text required) | Reach a subzone (area ID via `C_Map.GetAreaInfo`). Returns nil without `>>` text (4584) | zone events (the shared table of 151-155) | 4580 | 119 |
| subzoneskip | `areaId[,flags]` | Skip step when in (flag 1: not in) the subzone | zone events | 4621 | 246 |
| zone | `zoneName or mapId` (text required) | Reach a zone. Returns nil without `>>` text (4666) | ZONE_CHANGED_NEW_AREA, ZONE_CHANGED, NEW_WMO_CHUNK, PLAYER_ENTERING_WORLD, and ZONE_CHANGED_INDOORS when the client reports it valid (one table, 151, shared by zone, zoneskip, subzone and subzoneskip, 152-155; the fifth event is inserted at 160-163) | 4660 | 158 |
| explore | `areaId,zone` | Explore a subzone | MAP_EXPLORATION_UPDATED, UI_INFO_MESSAGE (4692) | 4693 | 0 |
| zoneskip | `zone[/zone...][,flags]` | Skip step when in (flag 1: not in) one of the maps; uses `C_Map.GetBestMapForUnit` (4758) | zone events | 4732 | 358 |
| clicknext | `guide` (rest of line) | Text line that loads another guide when clicked | — | 4770 | 2 |
| link | `url` (rest of line) | Clickable URL text | — | 4806 | 77 |
| cast | `[unit,]spellId,...` | Cast a spell. A `+` prefix on a spell ID is meant to mark a fail check, but the test is `v[1] == "+"` (4855), and indexing a string by number gives nil in Lua 5.1 (verified (harness)), so the branch never runs and `element.failcheck` is never set at parse: dead code upstream, as read | UNIT_SPELLCAST_SUCCEEDED, UNIT_SPELLCAST_FAILED_QUIET (203) | 4850 | 151 |
| unitscan | `entry;entry;...` (`+` prefix on the first entry = attach to parent) | Adds unit-scan targets. Each entry is a name, `Name::ID` or a bare NPC ID (`CheckNpcIds`, 4933-4949: on an English client `Name::ID` uses the name; otherwise the ID is kept and resolved to a localised name later) | UNIT_TARGET, QUEST_TURNED_IN, QUEST_ACCEPTED (192) | 4981 | 137 |
| target | as unitscan, including the `+` prefix (5011-5015) | Adds targeting-macro targets | as mob (193) | 5003 | 4560 |
| mob | as unitscan, including the `+` prefix (5033-5037) | Adds mob targets | UNIT_TARGET, QUEST_TURNED_IN, QUEST_ACCEPTED (191) | 5025 | 2124 |
| blastedLands | — | Fixed Blasted Lands collection text | as collect (204) | 5061 | 0 |
| questitemcount | `itemId,qty,questId,...` | Item count across quests | as collect (5139) | 5140 | 0 |
| bankdeposit | `item,...` | Deposit items at the bank | BANKFRAME_OPENED, BAG_UPDATE_DELAYED (156) | 5459 | 21 |
| bankwithdraw | `item,...` | Withdraw items | as bankdeposit (195) | 5483 | 5 |
| retrieveitem | `item,qty` | Retrieve from mail/bags | BAG_UPDATE_DELAYED, MAIL_SHOW (5535) | 5536 | 0 |
| bronzetube | `[rev]` | Step skip condition on item 4371: skips the step when the bag count is at least the number still needed for quest 174 (`rev` reverses) (5566-5579) | — | 5556 | 9 |
| buyAll | as buy | buy ignoring current count | as collect (117) | 5583 | 0 |
| buyUntilBroke | as buy | buy until out of money | as collect (118) | 5594 | 0 |
| buy | `itemId[,qty[,questId[,objIndex]]]` | Auto-buy at a vendor | as collect (116) | 5605 | 0 |
| skipgossip | `[option,...]` | Auto-select gossip options | GOSSIP_SHOW, GOSSIP_CLOSED, GOSSIP_CONFIRM_CANCEL, GOSSIP_CONFIRM (176) | 5693 | 21 |
| gossip | `npcId[,length[,flags]]` | Gossip with an NPC | GOSSIP_SHOW, PLAYER_INTERACTION_MANAGER_FRAME_HIDE, GOSSIP_CONFIRM (177) | 5769 | 0 |
| skipgossipid | `gossipId,...` (`+` = parent) | Select gossip by ID. **Returns nil without `C_GossipInfo.GetOptions`** (5835) | GOSSIP_SHOW, GOSSIP_CONFIRM (180) | 5834 | 160 |
| gossipoption | `gossipId` | Gossip option by ID; same gate (5908) | as skipgossip (179) | 5907 | 9 |
| maxlevel | `level[+xp][,label]` | Skip step above a level | PLAYER_XP_UPDATE (element.event, 5986) | 5966 | 11 |
| use | `itemId[:arg],...` | Puts items on the active-item bar | — | 6035 | 530 |
| macro | `name,icon >>body` | Creates/updates a macro button (`spell:ID` → spell name) | — | 6071 | 43 |
| usespell | `spellId[:arg],...` | Calls the same function as `use`, but the run-time branch tests the tag: with `usespell` the IDs are spell IDs and go to the active-spell buttons (`step.activeSpells`) instead of `step.activeItems` (6059-6064) | — | 6113 | 100 |
| vehicle | `[vehicleId]` | Enter a vehicle | UNIT_ENTERING_VEHICLE, VEHICLE_UPDATE, UNIT_EXITING_VEHICLE (181) | 6117 | 0 |
| exitvehicle | `[vehicleId]` | Leave a vehicle | as vehicle (182) | 6155 | 0 |
| itemcount | `itemId[;id...],[<>][=]N[,bank]` | Skip step unless the item-count condition holds (bags + equipped + toys) | — (no `events` entry) | 6173 | 685 |
| emote | `TOKEN[,npcId[,callback,events...]]` | Perform an emote at a target | PLAYER_TARGET_CHANGED (184) | 6254 | 0 |
| openmap | `map[,callback,events...]` | Open the world map | — | 6290 | 0 |
| cooldown | `type,id,[<>]N[m\|s][,updateOnce]` (type: spell, item, action, pet, inventory) | **Reads spell/item/action cooldowns and skips the step on the result**; guarded by `addon.IsSecretValue` (6393-6394) | SPELL_UPDATE_COOLDOWN, PLAYER_REGEN_ENABLED (190) | 6334 | 95 |
| logout | `[seconds]` | Camp/logout timer | PLAYER_CAMPING (6421) | 6422 | 0 |
| countdown | `[seconds]` | Countdown timer | — | 6462 | 0 |
| scenario | `stage,criteriaIndex[,objMax]` | Scenario criteria (pre-11.0 branch on Forever) | CRITERIA_UPDATE (6608) | 6611 (Forever) / 6516 | 0 |
| timer | `seconds[,timerText[,callback,events...]]` | Hands a timer to the parent element (`parent.timer`, 6686-6692). The bar starts only if the parent's own code starts it; see "Timer starts" below the table | — | 6680 | 47 |
| ironchain, bombdispenser, rescue, niffelen | — | Waypoint callbacks for specific Retail/Wrath quests (vehicle aura/seat checks) | — | 6706, 6725, 6727, 6735 | 0; helper |
| wptimer | — | Waypoint callback: time since activation | — | 6748 | 0; helper |
| wpbuff | — | Waypoint callback: player has buff (reads `UnitAura`) | — | 6769 | 0; helper |
| dmf, nodmf | `[skipTo]` | Darkmoon Faire active / not active | — | 6782, 6795 | 0 |
| holiday | `eventId[,reverse]` | Calendar holiday check | — | 6809 | 0 |
| pvp, pve | — | War Mode on / off | WAR_MODE_STATUS_UPDATE (6863-6864) | 6865, 6883 | 0 |
| noflyable, flyable | `zone[,skill]` | Can / cannot fly in zone | ZONE_CHANGED (6945, 6959) | 6946, 6960 | 0 |
| skyriding, noskyriding | `[label]` | Skyriding unlocked (`C_MountJournal.IsDragonridingUnlocked`) | ZONE_CHANGED (6983, 7008) | 6984, 7009 | 0 |
| collectmount | `mountId[,flags]` | Mount collected | COMPANION_* , NEW_PET_ADDED (185) | 7017 | 0 |
| collecttoy | `toyId[,flags]` | Toy collected | TOYS_UPDATED (186) | 7067 | 0 |
| collectpet | `npcId[,total[,flags]]` | Battle pet collected | as collectmount (188) | 7125 | 0 |
| tradeskill | `npcId,index` | Learn a trade skill recipe | as train (189) | 7182 | 0 |
| achievement | `id[,criteria[,numReq[,skipLabel]]]` | Achievement progress. **Returns nil without `GetAchievementInfo`** (7243) | CRITERIA_UPDATE, ACHIEVEMENT_EARNED (7239) | 7242 | 0 |
| achievementskip | `label,id[,criteria[,numReq]]` | Skip by achievement; same gate | as achievement (7308) | 7309 | 0 |
| achievementComplete, achievementIncomplete | as achievement | Skip-step variants | as achievement (7240-7241) | 7326, 7336 | 0 |
| isWorldQuestAvailable, isWorldQuestUnavailable | `map,questId[,remaining]` | World quest checks. **Return nil without `C_TaskQuest`** (7346) | — | 7345, 7387 | 0 |
| itemStat | `slot,STAT,[<>]value` (STAT may be `QUALITY`, `LEVEL` or a stat key) | Skip step unless the equipped item in `slot` meets the stat condition; uses `C_Item.GetItemStats` (alias `functions.lua:9`) | PLAYER_EQUIPMENT_CHANGED (7395) | 7396 | 795 |
| collectcurrency | `currencyId[,[<>]=N[,silent]]` | Currency amount | CURRENCY_DISPLAY_UPDATE (187) | 7475 | 0 |
| multiboxtext, singleboxtext | — | Text shown only in multibox / single mode | — | 7547, 7562 | 0 |
| multibox, singlebox | — | Step skipped outside multibox / in multibox mode | — | 7578, 7594 | 0 |
| dungeon | `TAG` or `!TAG` | Marks the step as a dungeon step (`step.dungeon`) or a skip-if-dungeon step (`step.dungeonskip`); tags from `addon.GetDungeonName` (`DB/forever/db.lua:175-191`). If `GetDungeonName` is missing the step is disabled. | — | 7612 | 72 |
| enabledungeon | `TAG` or `!TAG` | Parse-time: per-group dungeon override `addon.dungeonOverride[group][tag]` | — | 7651 | 20 |
| profession | `name` or `!name` | Profession-route step (`addon.GetProfessionId`, `DB/forever/db.lua:304-306`) | — | 7678 | 0 |
| group | `[N]` | Group-quest step (sets `step.group`) | — | 7711 | 25 |
| solo | — | Solo alternative step (sets `step.solo`) | — | 7738 | 3 |
| disablecheckbox | — | Makes the parent element text-only | — | 7748 | 104 |
| addtoquestdb | `index,key:value,...` | Parse-time: quest DB entries for the quest-log module | — | 7763 | 0 |
| convertquest | `srcId,dstId` | Quest ID substitution (`guide.questConversion`) | — | 7803 | 0 |
| mirrorquest | `srcId,dstId,...` | Mirror quest IDs (`guide.mirrorID`); note it tests `dst` at 7831 before the local of that name is declared at 7835, so the test reads an undeclared global and, as read, the function always takes the failure path: `addon.error` (a debug-only message, A4.4) and a nil return (inferred) | — | 7827 | 0 |
| aura | `[-]spellId[,[<]seconds[+\|-]\|stacks[,unit]]` | **Reads buffs/debuffs (`UnitBuff`/`UnitDebuff`) and completes/skips on them**; returns early when `C_Secrets.ShouldAurasBeSecret()` (7896) and in combat on 12.0+ (7903) | UNIT_AURA (7860) | 7861 | 48 |
| equip | `[-]slot[,itemId]` | Item equipped in slot | PLAYER_EQUIPMENT_CHANGED (7948) | 7949 | 39 |
| engrave | `[-]slot[,runeId]` | SoD rune engraving. **Returns nil unless `addon.player.season == 2`** (7991). The season comes from `C_Seasons` at run time (`RXPGuides.lua:214-221`, `:248`); nothing in the source fixes it for Forever, so "no-op on Forever" is not confirmed from source and needs the client (A11 item 8) | PLAYER_EQUIPMENT_CHANGED, RUNE_UPDATED (7989) | 7990 | 1 |
| openitem | `itemId` | Opens a container item | — | 8044 | 0 |
| isInScenario | `scenarioId[,skipTo]` | In-scenario check | SCENARIO_UPDATE (8054) | 8055 | 0 |
| enterScenario | `scenarioId,...` | Enter scenario | SCENARIO_UPDATE, SCENARIO_CRITERIA_UPDATE (8089) | 8090 | 0 |
| neutralzonefinished | — | Pandaren faction choice refresh | — | 8127 | 0 |
| beta | — | Text shown only on beta/PTR regions (`GetCurrentRegion() >= 20`) | — | 8143 | 0 |
| landfall, klaxxi, celestial, dailyhub | `poi[,arg]` / `hub,poi[,arg]` | MoP daily hub routing | — | 8149, 8153, 8157, 8161 | 0 |
| vale | `poi[,arg]` | MoP Vale daily routing | — | 8196 | 0 |
| isQuestOffered | `npcId,questId,...` | Quest offered by NPC | as gossip (178) | 8231 | 0 |
| dailyreset | `hub[,arg]` | Daily DB reset. Returns nil without `addon.dailyDB` | — | 8300 | 0 |
| skipOnQuest | `questId,label` | Jump to label when on quest | QUEST_ACCEPTED, QUEST_LOG_UPDATE, UNIT_QUEST_LOG_CHANGED (8316) | 8317 | 0 |
| skipto | `guide\|step,target` | Parent completion jumps to a guide or step label | — | 8350 | 0 |
| choose | `choiceId[,button]` | Player choice. Returns nil without `C_PlayerChoice` | PLAYER_CHOICE_UPDATE (8405) | 8406 | 0 |
| chromietime | `id` | Chromie Time. Returns nil without `C_ChromieTime` | PLAYER_INTERACTION_MANAGER_FRAME_SHOW (8428) | 8429 | 0 |
| scrap | `itemId,...` | Scrapping machine. Returns nil without `C_ScrappingMachineUI` | PLAYER_INTERACTION_MANAGER_FRAME_SHOW (8483) | 8484 | 0 |
| spec | `specIndex[,flags]` | Specialization check (`C_SpecializationInfo`) | — | 8500 | 0 |
| acceptmap | `questId` | Adventure map quest (`C_AdventureMap`) | ADVENTURE_MAP_OPEN (8521) | 8522 | 0 |
| totalbagslots | `[<]N` | Bag slot count; runtime not fully traced | — | 8537 | 0 |
| dualspec | `[skipstep]` | Learn dual spec; runtime not fully traced | PLAYER_ENTERING_WORLD, PLAYER_TALENT_UPDATE, ACTIVE_TALENT_GROUP_CHANGED (when valid) (209-218) | 8567 | 0 |
| showwhiledead | — | Step skipped while alive | PLAYER_ALIVE, PLAYER_UNGHOST (8605) | 8606 | 10 |
| show25quests | — | Quest-log module link; OnUpdate | OnUpdate (element.event) | `DB/questDB.lua:576` | 0; helper |
| turninconfig | — | Opens turn-in route settings | — | `DB/questDB.lua:598` | 0; helper |
| setturninhs | — | Parse-time: injects `.goto/.home/.bindlocation` lines for the chosen hearth location | — | `DB/questDB.lua:697` | 0 |
| setquestdb | `luaTableString` | Parse-time: **runs `loadstring` on guide text** (sandboxed with `setfenv(t, {})`) to build a quest DB (`DB/questDB.lua:1156-1157`) | — | `DB/questDB.lua:1150` | 0 |
| setturninroute | — | Turn-in route builder | — | `DB/questDB.lua:1171` | 0 |
| getTBCchapters | — | Value provider for `#chapters = getTBCchapters` | — | `DB/questDB.lua:1427` | 0; helper |
| tbcWBF | `[arg]` | TBC world-buff option | — | `DB/questDB.lua:1431` | 0 |
| requires | `mode,args...` (`quest`/`!quest`, …) | Requirement check for the quest-log module; runtime not fully traced | QUEST_LOG_UPDATE for quest modes (element.event) | `DB/questDB.lua:1459` | 0 |
| showtotalxp | `[flags]` | Shows total quest XP | QUEST_LOG_UPDATE (element.event) | `DB/questDB.lua:1525` | 0 |
| xpto60, xpto60alliance, xpto60horde, xpto60hc | — | XP-to-60 progress line | PLAYER_XP_UPDATE, QUEST_LOG_UPDATE (element.event, `DB/forever/db.lua:325`) | `DB/forever/db.lua:327`, `:335`, `:499`, `:495` | 0 |
| xpcheck | `guideName` | At level 24+ with certain quests done, loads a guide from group "RestedXP Horde 22-30" | PLAYER_XP_UPDATE | `DB/forever/db.lua:654` | 0 |

Version gates (parse returns nil, so the element is dropped; if the line
has `>>text` that text is still shown as a plain line, A4.4 step 5) that
matter on Forever: `mountcount` (always), `engrave` (unless season 2;
the season value needs the client), and API-presence gates for
`skipgossipid`, `gossipoption`, `achievement*`, `isWorldQuest*`, `choose`,
`chromietime`, `scrap`, `dailyreset`. Whether those APIs exist on Forever
needs the client (A11 item 4). `skipgossipid` (160 uses) and
`gossipoption` (9) are used by upstream Forever guides, and one Forever
guide uses `engrave` (`Guides/forever/Alliance-ADV-AoE-Mage-1-22.lua:1578`).
That usage is **not** evidence that `C_GossipInfo.GetOptions` exists on
Forever: if the API were absent, those lines would degrade silently to
their text, which an author would not necessarily notice. Both readings
fit the source; the in-game dump settles it.

Timer starts. The generic start in `SetElementComplete` is dead code: the
condition at `functions.lua:974` ends with
`not element.tag == "countdown"`, which Lua parses as
`(not element.tag) == "countdown"` and which is always false (verified
(harness) for the expression). A `.timer` line therefore starts a bar
only when its parent's own function calls `addon.StartTimer`: `accept`
(`:1303`), `turnin` (`:1503`), `complete` (through
`addon.UpdateQuestCompletionData`, `:1789`), `fly` (`:2908`), `cast`
(`:4899`), `skipgossip` (`:5758`), `gossip` (`:5826`), `skipgossipid`
(`:5891`), `gossipoption` (`:5962`), `vehicle` (`:6150`), `logout`
(`:6443`), `countdown` (`:6486`), `scenario` (`:6587`, `:6669`), and a
`.goto` with a positive radius when the player arrives (`map.lua:1333-1335`).
Under any other parent (`+text`, `.collect`, `.train`, `.home`, `.hs`
and so on) `.timer` does nothing, as read. The callback form
(`seconds,timerText,callback,events...`) stores its event list in
`element.events` (`:6682-6684`), a field nothing reads (the binder reads
`element.event`, `GuideWindow.lua:280`), so the listed events never fire
the callback; it runs only when the element is bound and on
`"WindowUpdate"` (`:6694-6697`).

Elements that read combat-adjacent state (relevant to CLAUDE.md "No combat
logic"): `.cooldown` (95 Forever uses) and `.aura` (48 Forever uses) branch
on cooldowns and auras; `wpbuff` reads auras; `.hs`, `.cast`, `.tame`
listen to the player's own spellcast events.

### A5.4 Text markup inside lines

| Markup | Meaning | Parsed at |
|---|---|---|
| `>>text` | Display text for the element on that line | `GuideLoader.lua:1013-1016` |
| `+text` | Manual objective with checkbox | `GuideLoader.lua:1054-1056` |
| `*text` | Text-only line, no tooltip; `\n` → newline | `GuideLoader.lua:1057-1063` |
| `\|cRXP_FRIENDLY_…\|r`, `RXP_ENEMY_`, `RXP_LOOT_`, `RXP_WARN_`, `RXP_PICK_`, `RXP_BUY_` | Colour tokens replaced by the user's colours (defaults `Themes.lua:124-131`; overrides `SettingsPanel.lua:4083-4094`). Raw `\|cAARRGGBB` codes are remapped through the same table. Applied to `text`, `rawtext`, `tooltipText`, `mapTooltip`, `title`, `arrowtext`. | `SettingsPanel.lua:4164-4202`; called from `GuideWindow.lua:905`, `:1742` |
| literal `\n` | Newline in the fields above and in `#arrowtext` | `SettingsPanel.lua:4179`; `GuideWindow.lua:2001` |
| `*quest*` | Replaced with the quest's name (accept, turnin, abandon) | Detected at `functions.lua:1181-1183` (accept), `:1413-1415` (turnin), `:4111-4113` (abandon); replaced at `:1227`, `:1440`, `:4126` |
| `npc:Name:ID`, `\|c…Name::ID\|r` | Replaced with the localised NPC name by ID | `functions.lua:925-951`; called `GuideWindow.lua:1328`, `:2230`, `:2318`, `:3142` |
| `\|Tpath:size\|t` | Native WoW texture escape; passed through untouched | (not parsed) |
| `<<` | Always starts a condition (A3) | `GuideLoader.lua:991` |
| `--` | Always starts a comment (A1) | `GuideLoader.lua:1106`, `:1134` |

---

## A6. Loader pipeline

### A6.1 Registration

1. Guide files run during addon load and call `RXPGuides.RegisterGuide(text)`
   (the global is bound to `addon.RegisterGuide` at
   `GuideLoader.lua:1389-1391`) → `addon.RegisterGuide`
   (`GuideLoader.lua:522-539`) → queued in `addon.embeddedGuides`
   (`GuideLoader.lua:26-27`, `:532-538`). Queueing rather than immediate
   parsing follows from `addon.addonLoaded` being `nil` at that point
   (A2.3 rule 3).
2. `OnInitialize` (`RXPGuides.lua:1491` onwards) calls
   `addon.LoadCachedGuides()` (`RXPGuides.lua:1601`; imported guides, see
   A6.3), then `addon.LoadEmbeddedGuides()` (`RXPGuides.lua:1649`; or in
   time-sliced batches on hardcore realms, `:1638-1647`, `:1349-1362`), then
   sets `addonLoaded = false` (`:1653`).

### A6.2 Pre-scan, parse and storage of file guides

`LoadEmbeddedGuides` (`GuideLoader.lua:755-795`) calls the local
`LoadGuide(guideData, n)` (`GuideLoader.lua:648-747`) for each queued
guide:

1. **Pre-scan** of the header (A2.3 rule 4) extracts `#group`, `#subgroup`,
   `#name`, bare `<<` (`:657-698`) and builds the pre-scan key
   `BuildGuideKey(group, "", name)`: group, an **empty** subgroup and the
   name as written, not zero-padded (`:691`, `BuildGuideKey` at
   `:797-805`).
2. **Metadata cache hit.** If `RXPCData.guideMetaData[key]` (saved per
   character from a previous session, looked up under the pre-scan key)
   exists and its `length` equals the guide text length, the guide is
   **not parsed now**: the cached metadata table is registered, and a
   closure that parses on demand is stored in `addon.guideCache` under
   the metadata's own `key` field, which is the guide's final key
   (`:700-719`). When that closure later runs it calls `ParseGuide`
   without the `isEmbedded`, `group` and `key` arguments (`:711`), and it
   writes `RXPCData.guideMetaData[guide.key] = metadata` with a
   `metadata` variable that is never assigned on this path, so it stores
   `nil` (`:653`, `:712-714`).
3. **Cache miss.** `addon.ParseGuide(text, nil, defaultFor, true, group, key)`
   parses fully (`:720-724`) and stores fresh metadata in
   `RXPCData.guideMetaData` under the **pre-scan key**, after deleting
   any older entries that describe the same guide (`:727-738`). The
   guide's own key, rebuilt after parsing with the subgroup and the
   zero-padded name (`:1295`), is kept inside the metadata as its `key`
   field. Metadata = all scalar guide fields plus `length` and
   `defaultFor` (`:1304-1312`).
4. `addon.AddGuide(guide)` (`GuideLoader.lua:128-206`) inserts the guide
   into `addon.guides["group||name"]` and the menu list
   `addon.guideList[displayGroup]` (`names_` array). Low-priority guides
   go into the `*group` list (`:155-160`, `:162-176`). The first
   non-low-priority entry that has a `defaultFor` field (capital F)
   becomes a provisional `addon.defaultGuide` (`:202-203`; upstream marks
   the lines "TODO: remove this part"). Only cached metadata tables carry
   that field (`:1312`); a freshly parsed guide carries `defaultfor`, so
   this assignment fires only for entries added from cached metadata. The
   value stored here is a guide table, and the menu builder later
   replaces it with a guide name (A6.6).
5. Lazy parses: `addon:FetchGuide` (`GuideWindow.lua:1767-1834`) runs the
   `guideCache` closure when a guide is opened or included. The update
   loop also parses cached guides in the background (A7.1): on odd ticks
   with nothing more urgent to do, it parses queued guides one after
   another until about 20 ms have been spent or the frame rate is below
   50, and it always takes `#disablecaching` guides
   (`RXPGuides.lua:2217-2243`, `:2222`, `:2230-2233`).
6. `RXPCData.guideDisabled[n]` records guides rejected by the pre-scan,
   keyed by position `n` in the queue with the text length as the value
   (`GuideLoader.lua:694`); a set slot makes the loader skip queue entry
   `n` without comparing the length or the name (`:655-656`). At the
   start of every `LoadEmbeddedGuides` call the whole table is replaced
   by `{[0] = nGuides}` unless the stored count `[0]` is **greater** than
   the current queue length (`:766-769`). With the same number of queued
   guides as when the table was written, which is the normal case, the
   table is therefore rebuilt on every call and the rejection cache has
   no lasting effect. The exception, as read: if fewer guides are queued
   than the saved count (for example after guide files are removed from
   the guide list), the saved table is kept and its position-keyed
   entries are applied to whatever guides now sit at those positions.
   The table is also emptied, together with the metadata cache, by
   `CreateMetaDataTable` when the addon release or cache version
   changes, for a new character, or when `preLoadData` is on
   (`RXPGuides.lua:1288-1291`). Relevant to anyone who adds, removes or
   reorders guide files; untested in client.

### A6.3 Parser differences for imported guides (parser side only)

- Imported guides arrive through `addon.ImportGuide` (`GuideLoader.lua:499-520`)
  and are stored compressed in `addon.db.profile.guides` via
  `addon.CacheGuide` (`:477-496`). Before compression, `CacheGuide`
  collapses whitespace, strips `--` comments and prepends a
  `--<number>` header derived from `addon.ReadCacheData("string")`
  (`:486-489`; the key derivation is Part B).
- `ParseGuide` treats text starting `--<digits>` as imported: the length
  comes from that header and comments are not stripped again
  (`GuideLoader.lua:1098-1109`).
- `LoadCachedGuides` (`GuideLoader.lua:809-945`) decompresses with
  LibDeflate, accepts a guide only if it starts with the expected
  `--<number>` (`:926-934`), checks `enabledFor`, and marks it
  `imported = true` (`:914`, `:937`). Imported guides skip the `#FOREVER`
  pre-scan.

### A6.4 Loading a guide for display

`addon:LoadGuide(guide, OnLoad)` (`GuideWindow.lua:1840` onwards):

1. Saves progress of the current guide (`:1843`). Loads the empty guide
   instead when the guide is missing, `#internal` or `#disabled`, or
   when it is not the empty guide, fails `IsGuideActive` **and** its farm
   flag does not match the gold-assistant mode (`guide.farm` without
   `RXPCData.GA`, or the reverse) (`:1845-1848`). An inactive guide whose
   farm flag matches the mode is therefore still loaded.
2. `FetchGuide` parses on demand (`:1853`; `GuideWindow.lua:1767-1834`).
   If the stored key misses, it retries with `GroupOverride`, group
   aliases and the zero-padded name (`:1768-1786`, `:1799-1807`).
3. Forces softcore on non-CLASSIC games (`:1865-1868`).
4. Unless `OnLoad`, clears `RXPCData.stepSkip` and
   `RXPCData.completedWaypoints` and re-runs
   `addon.settings:DetectXPRate(true)` (`:1894-1899`). The login
   restore passes `OnLoad` (`RXPGuides.lua:1401`) and a guide reload can
   pass it (`GuideWindow.lua:2164`); a menu click and `#next` chaining
   (`functions.lua:3960`) do not, so they clear both tables.
5. `addon.ProcessGuideTable(guide)` (`GuideWindow.lua:1627-1765`) builds
   `addon.currentGuide`: copies scalar fields, then walks the steps,
   keeping only those for which `IsStepShown(step, currentGuide)` is true
   (`:1684`). Includes:
   - **Guide-level `#include`** is processed first (`:1762`).
   - **Step `#include group\name@start-stop`**: the pattern
     `(.-)%s*\\?%s*([^\]+)` splits group and name (verified (harness):
     `RestedXP Forever Guide (H)\1-6 Durotar` → group
     `RestedXP Forever Guide (H)`, name `1-6 Durotar`; with no backslash
     the current guide's group is used, `:1651-1655`). `@start-stop` takes
     labels or stepIds (`:1657-1662`). Included steps are deep-copied
     (`:1706-1731`); a step that has only `#include` and no elements,
     `#requires` or `#label` is not itself added (`:1705`). Recursion is
     guarded by `guideRef` (`:1673-1677`).
   - The `#include *label` / `.label` path is dead: it tests the misspelt
     field `step.inlcude` (`:1690`) and `IncludeGuide` returns early for a
     leading `*` (`:1647`).
   - Steps with `#tip` go to `currentGuide.tips` (`:1732-1735`).
6. Restores the saved step by `stepId` first, then by index (`:1929-1938`).
7. Post-processing per step (`:1995-2017`): `index`, empty → optional,
   `#arrowtext` newlines, `#completewith` → sticky, `#requires` linking,
   `#level` to number, `#label` table.

### A6.5 `#next` chaining

`addon.functions.next` (`functions.lua:3863-3972`), called by `SetStep`
when stepping past the last step and no sticky step is pending
(`GuideWindow.lua:768-788`), or when no step can be activated
(`:917-922`):

- Splits `#next` on `;` (`:3901-3902`). Each entry may be `group\name`
  (verified (harness) for the `^%s*(.+)\\%s*` split, `:3903-3906`); else the
  current group is used. Once an entry names a group, that group stays
  in force for the later entries of the same `#next` line, because the
  variable is not reset between entries (`:3903-3906`). Names are
  zero-padded (`:3907`).
- Also searches groups that share a display name (`condenseGroups`,
  `:3909-3923`).
- Takes the first entry that exists and passes `IsGuideActive`; otherwise
  falls back to the last name (`:3924-3929`, `:3952`).
- On non-CLASSIC games swaps Aldor/Scryer names (`:3932-3940`).
- If the target fails the season or hardcore checks, recurses to that
  guide's own `#next` (`:3954-3957`). Otherwise `addon:LoadGuide(nextGuide)`
  (`:3960`). If the name lookup fails after substitution but an inactive
  candidate was found, it recurses to that candidate's `#next`
  (`:3966-3969`).
- If nothing is found the function returns without loading anything
  (inferred: the window stays on the last step).

### A6.6 Default guide selection

Summary: on Forever no guide is loaded automatically for a fresh
character. The guide configurator opens and the player picks a guide
from a list. Everything below is read from source; untested in client.

- `addon.defaultGroup` on Forever = `"RestedXP Forever Guide (H)"` / `(A)`
  by faction (`DB/forever/db.lua:34-40`).
- While building the menu, `addon.defaultGuide` is set to the name of the
  **first active guide by sorted name** in that group
  (`GuideWindow.lua:2540-2545`, `:2600-2603`). This replaces the
  provisional value from `AddGuide` (A6.2 step 4).
- `addon.SelectDefaultGuide()` (`GuideLoader.lua:966-975`) loads that guide
  only for a level-1 character with no guide loaded. Its only caller is
  the configurator's `FinishFlow(true)`
  (`UI/V2/GuideConfigurator.lua:1464-1471`), and `FinishFlow` is called
  with `true` only by `pageForward` on a page that has no next page
  (`:1490-1502`; `pageForward` is the submit button's click handler,
  `:1526`). In the Forever flows every page that shows a submit button
  has a next page, and the pages that end the flows show no submit
  button (below), so on Forever `SelectDefaultGuide` is not reached
  through the configurator.
- `addon.LoadDefaultGuide` (called two seconds after
  `PLAYER_ENTERING_WORLD` when no guide is loaded and no saved guide
  group exists, `RXPGuides.lua:1810-1818`) is defined only in
  `DB/mainline/db.lua:91` and `DB/mop/db.lua:52`, so on Forever that call
  does nothing (inferred).
- **What opens instead.** Every `PLAYER_ENTERING_WORLD` calls
  `addon.ui.v2.configurator:Open(true)` (`RXPGuides.lua:1831`). With the
  login flag it returns early when a saved guide name exists, when a
  non-empty guide is loaded, or when the character is not level 1
  (`UI/V2/GuideConfigurator.lua:1533-1540`); otherwise it shows the
  configurator. The only other gate is the supported-client test, which
  includes FOREVER (`:12-16`, `:1067-1068`); the `enableV2Interface`
  setting is not consulted on this path.
- **Forever flows.** On Forever the first page offers two cards
  (`:1783-1801`):
  - "Open World Guide" → settings page `foreverOpenWorldOptions`
    (`:2096-2105`) → choices page `speedrunGuides`, which lists guides of
    `addon.defaultGroup` (`:2028-2038`).
  - "Dungeon Guide" → settings page `foreverDungeonOptions` → dungeon
    settings page `foreverDungeonOptions2` → choices page
    `foreverDungeonGuides`, which lists guides of
    `RestedXP Forever Dungeon Guide (H)` or `(A)` (`:2106-2140`).

  Each settings page has a next page, and a choices page shows no submit
  button (`:1444-1449`). The guide that gets loaded is the one the
  player clicks: the choice's callback calls
  `addon:LoadGuide(selectedGuide)` and then `FinishFlow()` with no
  argument (`:1667-1680`).
- **How the list and the recommendation are built**
  (`GetGuideChoices`, `:1557-1682`):
  1. Guides come from `addon.GetSelectableGuidesInGroup(group, nil, true)`
     (`GuideLoader.lua:291-308`); the `true` includes low-priority
     guides. They are sorted by name (`:1576`).
  2. For the default group and the Forever dungeon groups, the list is
     filtered to guides whose **display name** contains a level range
     `N-M` that includes the player's level (`:1578-1593`).
  3. The recommended guide is, in order: the currently loaded guide; the
     first guide whose display name contains the current zone or subzone
     name (`GetRealZoneText`, `GetSubZoneText`, compared in lower case)
     and whose `#defaultfor` applies, or failing that the first
     zone-matching guide without a `#defaultfor`; for the default group,
     the guide named by `addon.defaultGuide`; the first guide whose
     `#defaultfor` applies (`:1595-1647`). It is moved to the top and
     flagged `recommended` (`:1649-1666`).
  4. Picking a guide other than the recommended one sets
     `profile.showUnusedGuides = true` (`:1668-1671`).

  Which guide ends up highlighted for a given character depends on the
  zone text the client returns and is not confirmed from source (A11
  item 9).

---

## A7. Step engine

### A7.1 Update loop

- `addon.tickers:SetupTickerLoops()` (`RXPGuides.lua:2317-2332`) creates one
  `C_Timer.NewTicker` (`RXPGuides.lua:77`) running `addon.LegacyUpdateLoop`
  (`RXPGuides.lua:2100-2314`). It is started in `OnEnable`
  (`RXPGuides.lua:1767`).
- **Interval: 0.075 s default confirmed** (`RXPGuides.lua:2057`), overridden
  by `profile.updateFrequency` in milliseconds (minimum 0.005 s,
  `:2059-2061`; the setting's own default is 75,
  `SettingsPanel.lua:166`) and multiplied by 1.5 on hardcore realms
  (`:2062-2064`). The ticker is created once (`if not self.legacy`,
  `:2330-2332`) and is not recreated when the setting changes, so a new
  value takes effect only after a reload.
- The loop returns at once in standby mode (`profile.standbyMode` without
  `profile.showEnabled`, `:2103`) and while the window is hidden
  (`:2362-2366`). An error counter rises by one on each tick that
  follows a tick which did not reach its end, either because of an error
  or because it left through one of the early returns at `:2170` and
  `:2207` (`:2105-2107`, `:2122`, `:2313`); when it reaches 10
  the loop skips that one tick, records `addon.lastEvent`, resets the
  counter to 0 and runs again on the next tick (`:2368-2376`). It does
  not stop. The loop also skips every other tick when the frame rate is
  at or below the tick rate (`:2114-2119`).
- Per tick, in priority order (`:2130-2244`): flush
  `addon.updateActiveQuest` (quest objective refreshes) → if
  `addon.nextStep` jump to it → else if `addon.loadNextStep` advance one
  step → else, only when no quest refresh ran this tick: if
  `addon.updateSteps` run `UpdateStepCompletion` → else, on even ticks,
  refresh step text → else refresh the step list → else, on odd ticks
  and while `addon.guideCache` is not empty, parse queued guides in a
  time-budgeted batch: guides are fetched one after another until about
  20 ms have elapsed or the frame rate is below 50, and every
  `#disablecaching` guide is fetched regardless (`:2217-2236`; on a
  hardcore realm one guide per tick through a separate loader).
- Then a counter `skip` drives sub-cycles (`:2246-2311`): `skip%4==0`
  `UpdateGotoSteps` (arrival, A8); `==2` quest automation and map refresh;
  `==3` message queue, scheduled tasks, quest-cache clear; `skip%16==1`
  inactive-quest data (max 3 per tick); `skip%32==29` step text; otherwise
  incremental step-list redraw. Inferred: waypoint arrival is checked about
  every 4 ticks (≈0.3 s at default).

### A7.2 Events → flags

- Each active element gets its own frame with its own event registrations
  (`GuideWindow.lua:271-304`); its handler calls the element function only
  while the step is active, else unregisters (`:253-269`). The v2 guide
  window binds its rows through the same function
  (`UI/V2/Core.lua:2897`).
- An element whose event list contains `"OnUpdate"` gets the element
  function as the frame's OnUpdate script, so it runs every frame,
  outside the ticker (`GuideWindow.lua:284-302`).
- Element functions set `element.completed`/`skip` through
  `addon.SetElementComplete` (`functions.lua:962-998`), which sets
  `addon.updateSteps = true` and requests a map update. Skip conditions set
  `step.completed = true; addon.updateSteps = true` directly. 56 lines in
  `functions.lua` set `addon.updateSteps = true`, and 63 across all
  engine files (4 in `GuideWindow.lua`, 3 in `DB/questDB.lua`; search
  `updateSteps = true`).
- The ticker sees `updateSteps` and runs `UpdateStepCompletion`.

### A7.3 Completion

`addon.UpdateStepCompletion` (`GuideWindow.lua:681-757`), over the active
steps:

- A step is complete when every element is `completed`, `skip` or
  `textOnly` (`:692-699`).
- `#completewith next|label`: complete when the current step index has
  passed the target, or when the target is sticky and has been skipped
  (`:702-724`).
- A completed **sticky** step is recorded in `RXPCData.stepSkip[index]`
  (`:738-741`). A completed current step sets `step.completed` and
  `addon.loadNextStep = true` (`:742-751`); the next tick advances.
- `addon.SetStep(n)` (`GuideWindow.lua:759` onwards) saves progress, fires
  `RXP_STEP_ACTIVATED`, skips sticky/completed steps forward, re-activates
  earlier sticky steps whose `#requires` are met and level allows
  (`:846-883`), activates step `n` if `#requires` and `#level` allow
  (`:888-915`), else moves on (`:917-923`).

### A7.4 Manual completion and skipping

- Clicking an element checkbox toggles `element.skip`
  (`addon.ActiveStepElementPostClick`, `GuideWindow.lua:239-251`); elements
  with `optional` cannot be toggled.
- The step-list menu offers "Go to step N" (`GuideWindow.lua:1582-1588`,
  `:2078-2079`), which calls `SetStep(N)`.
- The setting `profile.disableAutoSkip` suppresses automatic skipping in
  only 12 functions of `functions.lua`: `areapoiexists` (`:4241`),
  `questcount` (`:4329`), `isQuestComplete` (`:4369`, which also serves
  `isQuestNotComplete`), `isOnQuest` (`:4419`, also `isNotOnQuest`),
  `isQuestTurnedIn` (`:4485`, also `isQuestAvailable`), `pvp` (`:6877`),
  `flyable` (`:6976`), `skyriding` (`:6995`), `isInScenario` (`:8072`),
  `enterScenario` (`:8114`), `dailyhub` (`:8187`) and `vale` (`:8222`)
  (search `disableAutoSkip`). No other function reads it, although 54
  lines in the file set `step.completed = true`. Skip conditions such as
  `.zoneskip` (`:4764-4766`), `.itemcount` (`:6237-6241`),
  `.bindlocation` (`:2732-2734`) and `.bronzetube` (`:5576-5578`)
  therefore skip regardless of the setting, and so does every other
  skip-type function outside the list of 12.

### A7.5 Persistence

`addon.SaveGuideProgress` (`RXPGuides.lua:1412-1436`) writes per character:
`RXPCData.currentStep`, `RXPCData.currentStepId`, and
`RXPCData.guideProgress[guide.key] = {step, stepId}`; also
`guideProgress.playerGUID` on first save. `LoadGuide` writes
`RXPCData.currentGuideName/Group` (`GuideWindow.lua:1955-1956`).
`addon.GetGuideProgress` (`RXPGuides.lua:1438-1466`) reads them back,
migrating the old single-guide fields. Sticky-step completion lives in
`RXPCData.stepSkip`, reached waypoints in `RXPCData.completedWaypoints`;
both are cleared on every `LoadGuide` call that does not pass `OnLoad`,
which includes a menu click and `#next` chaining
(`GuideWindow.lua:1894-1896`; A6.4 step 4).
At login `OnInitialize` reads the saved `currentGuideGroup/Name` and
progress (`RXPGuides.lua:1614-1616`) and calls `LoadCache()` (`:1618`),
whose per-frame handler re-opens that guide with
`addon:LoadGuide(g, true)` once it can be found (`:1385-1404`). With
`profile.preLoadData` set it also calls `addon.LoadAllGuides()`
(`:1626-1628`). On level 1 with a GUID mismatch the user is
asked to reset progress (`RXPGuides.lua:1777-1795`).

---

## A8. Navigation

### A8.1 Position source

- **HereBeDragons-2.0** (minor 35, `libs/HereBeDragons/HereBeDragons-2.0.lua:3`)
  is used for all arrow and arrival maths: `HBD:GetPlayerWorldPosition()`
  (`map.lua:123`, `:1253`), which calls `UnitPosition("player")`
  (`HereBeDragons-2.0.lua:661-668`), and `HBD:GetWorldVector` for angle and
  distance (`map.lua:124`, `:1292`).
- HereBeDragons has its own Forever branches and ships **no** static
  zone table. It sets a `WoWForever` flag from
  `WOW_PROJECT_ID == WOW_PROJECT_CAMELOT` (`HereBeDragons-2.0.lua:19`),
  uses an empty instance-transform table on Forever (`:102-103`) and
  Forever-specific world-map dimensions (`:253-255`). Its per-map data
  is built at load from the client: `C_Map.GetMapInfo`,
  `C_Map.GetWorldPosFromMapPos` and `C_Map.GetMapWorldSize` for every
  map reachable from the world map (`:156-196`, `:293-295`), followed by
  a scan of UiMapIDs 1 to 3000 to fill gaps (`:303-310`). Whether
  HereBeDragons can convert coordinates for a given map, including 2521
  and the unpublished Forever maps, therefore depends on what `C_Map`
  returns in the client, not on shipped data. A UiMapID above 3000 that
  is not reachable from the world map would be missed (as read).
- Pins: **HereBeDragons-Pins-2.0** `AddWorldMapIconMap` /
  `AddMinimapIconMap` (`map.lua:6`, `:940`, `:950`, `:1002`).
- `C_Map.GetPlayerMapPosition` is **not** used by the guide engine (only
  `Communications.lua:471` and `CptStadicsVendorTreasures.lua:17-18`).
- `C_Map.GetBestMapForUnit` is used for zone checks (`.zoneskip`
  `functions.lua:4758`, `.fp` `:2815`); `UnitPosition` is called
  directly by `.fp` through `addon.GetNearestFp` (`:2747`, called at
  `:2830`) and by `.fly` (`:2877`). `.bindlocation` uses no position
  API; it compares `GetBindLocation()` (`:2732`).
- The arrow is hidden inside instances (`IsInInstance`, `map.lua:1258-1260`)
  and marked "wrong continent" when the arrow target's instance differs
  from the player's and the player's instance is not `-1`
  (`af.element.instance ~= instance and instance ~= -1`,
  `map.lua:1254-1256`).

### A8.2 `.goto` coordinate forms

`addon.functions["goto"]`, `functions.lua:1917-2016` (parse branch
`:1918-2012`):

| Form | Example | Handling |
|---|---|---|
| Zone name or UiMapID + percent coordinates | `.goto Silverpine Forest,42.98,73.22` (`forever/dungeon/Horde-12-22_Barrens.lua:2380`) / `.goto 2521,42.82,23.41` (`forever/RestedXP-Skyborne.lua:18`) | `addon.GetMapInfo(zone,x,y)` (`map.lua:1534-1575`) → `addon.GetMapId(zone)` (`map.lua:1525-1532`, a lookup in `addon.mapId`) or `tonumber(zone)`; world coordinates computed with `HBD:GetWorldCoordinatesFromZone` (`functions.lua:1950`, `:1961-1963`). |
| `UiMapID/instanceID` + **world** coordinates | `.goto 1411/1,-4251.46,-607.35` (`forever/Horde-01-12_Durotar.lua:21`) | `zone:match("(.-)/(%d+)")` (verified (harness)); x,y are world (yard) coordinates; zone percent computed with `HBD:GetZoneCoordinatesFromWorld` (`functions.lua:1928-1950`); `element.fixedMapID = true`. |

Upstream Forever guides use the second form almost exclusively (count of
`.goto <digits>/<digits>,` lines in `Guides/forever/`: the largest are
`1439/1` 1632, `1413/1` 1542, `1426/0` 1389, `1429/0` 1206, `1411/1`
1067; only one zone-name `.goto` line), except the Skyborne guide, which
uses `.goto 2521,x,y` (1026 lines).

Points about the world-coordinate form that a recorder or author must
get right (as read; untested in client):

- **Axis order.** In `.goto <UiMapID>/<instance>,a,b` the first number
  `a` is stored as `element.wx` and the second `b` as `element.wy`
  (`functions.lua:1928-1943`). They are compared with
  `HBD:GetPlayerWorldPosition()` (`map.lua:1253`, `:1292`), which reads
  `local y, x, _z, instanceID = UnitPosition("player")` and returns
  `x, y, instance` (`HereBeDragons-2.0.lua:661-668`). So `a` corresponds
  to the **second** return of `UnitPosition` and `b` to the **first**.
  A recorder that writes this form from `UnitPosition` must emit
  (second return, first return).
- **The map must still be known to HereBeDragons.** If
  `HBD:GetZoneCoordinatesFromWorld(x, y, zone)` returns nil, which it
  does when HereBeDragons has no size data for that map
  (`HereBeDragons-2.0.lua:462-468`), the element gets no coordinates and
  is dropped with only a debug-mode message, "Invalid coordinates or map
  name" (`functions.lua:1940-1948`, `:1952-1956`). Giving world
  coordinates does not remove the dependence on map data (A8.1).
- **The zone cannot be omitted.** The function keeps the last zone it
  saw and falls back to it when the zone argument is nil
  (`functions.lua:1916`, `:1922-1926`; the same code is in `waypoint`
  `:2118-2122`, `pin` `:2245-2249`, `ingamewaypoint` `:2311-2315` and
  `loop` `:2555-2559`). Because arguments are positional and empty
  fields are dropped (A4.4 step 4), the zone is nil only when the line
  has no arguments at all, and then the coordinates are missing too and
  the element is dropped. A line such as `.goto 45.2,33.1` is read as
  zone `45.2`, x `33.1`, no y. No guide file in this checkout writes a
  coordinate line without a zone. Always write the zone.

Zone names resolve through `addon.mapId`, defined for Forever in
`DB/forever/db.lua:46-97`: the classic UiMapIDs 1411–1459 for the old
zones, `Kalimdor` 1414, `Eastern Kingdoms` 1415, and one Forever-only
zone, `Zephras Isle` 2521 (`DB/forever/db.lua:96`; provenance:
upstream). **No other Forever-only zone (Riverglades, Shen'dralas, …) is
in the table.**
`addon.ignoredMaps` lists Outland/BC zones whose errors are suppressed
(`DB/forever/db.lua:99-116`; used at `functions.lua:286`).
`addon.mapConversion` is empty for Forever (`DB/shared.lua:3`).
Special zone names `StormwindClassic/New`, `EPLClassic/New` apply
coordinate transforms that depend on the interface number
(`map.lua:1539-1566`). On Forever (interface below 30000)
`StormwindNew` and `EPLNew` coordinates are converted to the classic
layout (`:1554`, `:1561`), while `StormwindClassic` and `EPLClassic` are
used as written, because their conversion runs only above 30000 or when
`WOW_PROJECT_ID == WOW_PROJECT_MAINLINE` (`:1540`, `:1547`).

### A8.3 `.goto` arguments `radius` and `optional`

`functions.lua:1958-2008` (arguments: `zone,x,y[,radius[,optional]]`; note
`optional` is a string, so `"0"` counts as present):

| radius | optional | Result |
|---|---|---|
| absent | — | Arrow + pin, text-only; never completes by itself; ignored once the parent element completes |
| `> 0` | absent | A checkbox element that completes when the player is within `radius` yards |
| `> 0` | present (e.g. `,30,0`) | Arrow-only path waypoint, no pin (`hidePin`), bound to the parent; skipped on arrival so the arrow moves to the next one |
| `0` | absent | Pin only, no arrow |
| `0` | present | Low-priority waypoint (arrow only when nothing else) |
| `< 0` | either | Dynamic: the closest of a set of points is the arrow target |

### A8.4 Arrival logic

`addon.UpdateGotoSteps` (`map.lua:1222` onwards) runs every 4th tick
(A7.1) and is also queued through `addon:ScheduleTask` when a shown
arrow is left without a target (`map.lua:1142-1144`). For each active waypoint it takes
the distance via `HBD:GetWorldVector`; if `dist <= radius` (radius in
yards) and an objective-progress check passes, the waypoint is marked
`skip` and, if not text-only, its element completed
(`map.lua:1288-1337`). A timer handed to the waypoint by a `.timer` line
starts at that moment (`:1333-1335`). Exceptions on arrival:

- `.wpradius` adds an activation radius that hides a waypoint until the
  player is near a reference point (`map.lua:1269-1287`). It also sets
  `persistent` on the waypoint (`functions.lua:2212-2237`), and a
  persistent waypoint is only hidden on arrival, not marked `skip` or
  completed; it is shown again when the player moves out of range
  (`map.lua:1324-1325`, `:1341-1343`).
- An arrow-only path waypoint (`textOnly` and `hidePin`, the
  `radius,optional` form of A8.3) is consumed only when it is the
  arrow's current target (or was generated by the engine); reaching a
  later one out of order does not consume it (`map.lua:1326-1327`).

The arrow (`addon.DrawArrow`, `map.lua:102` onwards, OnUpdate of
`RXPG_ARROW`, `map.lua:41`, `:99`, so it runs every frame) rotates by
`angle - GetPlayerFacing()` and shows floor(distance). Target choice:
for a ghost, the corpse or, in a `.deathskip` step, the nearest Spirit
Healer takes precedence over guide waypoints, unless the step has
`#ignorecorpse` (`map.lua:1059-1109`); otherwise the first active
waypoint, then low-priority ones (`map.lua:1111-1123`).

---

## A9. Forever-specific branches in the DSL/engine files

Search: `grep -n -i "forever\|camelot\|16001"` over `GuideLoader.lua`,
`functions.lua`, `RXPGuides.lua`, `GuideWindow.lua`, `map.lua`, `QuestLog.lua`.
`map.lua` and `GuideWindow.lua` have **no** hits.

| Location | Branch | Effect |
|---|---|---|
| `RXPGuides.lua:204-207` | `gameVersion >= 16000 and < 20000` | `addon.game = "FOREVER"`, max level 60, zhCN guides enabled |
| `RXPGuides.lua:253-258` | `addon.game == "FOREVER"` | Player name built from both `UnitName` returns ("first last") |
| `RXPGuides.lua:123` | `_G.WeakAuras or _G.ForeverAuras` | WeakAuras detection also accepts `ForeverAuras` |
| `RXPGuides.lua:585-588`, `:630-634` | `WOW_PROJECT_ID == WOW_PROJECT_CAMELOT` | Trainer auto-buy: ignores the pet trainer window; buys in reverse order |
| `RXPGuides.lua:1397-1400` | commented out | `-- TODO: Fix the dungeon selection for Camelot` |
| `RXPGuides.lua:1545-1554` | FOREVER and `lootSparkle` | Sets outline/loot-effect CVars |
| `RXPGuides.lua:2495` | CLASSIC or FOREVER | Aldor/Scryer check always passes |
| `RXPGuides.lua:2519-2525` | FOREVER | Phase default 5 and any saved phase forced to 5 |
| `GuideLoader.lua:679` | CLASSIC and `#FOREVER` | Classic Era also loads `#forever` guides … |
| `GuideLoader.lua:702`, `:920`, `:1272-1274` | CLASSIC and forever and not classic | … but as low priority |
| `GuideLoader.lua:676-681` (via `"#" .. addon.game`) | FOREVER | Embedded guides need a `#forever` header line |
| `GuideLoader.lua:1170-1171` | FOREVER and `guide.classic` | Parser accepts `#classic` guides on Forever |
| `functions.lua:259-262` | `gameVersion > 50000 or WOW_PROJECT_CAMELOT` | Modern POI icon coordinates for goto/home/deathskip icons |
| `functions.lua:2932` | comment | Notes the resurrection spell 418460 on Forever |
| `QuestLog.lua:27` | FOREVER | Default quest-log size 40 (CLASSIC 20, else 25) |
| `UI/V2/GuideConfigurator.lua:1473-1476` | FOREVER | Saves settings locally when the configurator finishes. The file is outside the six searched files; it tests `addon.game` against FOREVER at lines 15, 1160, 1223, 1263, 1473, 1517, 1783, 1906, 1991, 2005, 2030, 2035 and 2066, treats the two Forever dungeon groups specially at 1573-1574 (used at 1578, 1595, 1668) and names them again at 2115-2137. The supported-client test (15), the first-page cards (1783-1801) and the Forever pages (2066-2141) are described in A6.6; the other branches were not analysed |
| `DB/forever/db.lua:3` | `addon.game ~= "FOREVER"` | Whole Forever DB file returns early on other games |

Version gates keyed on `gameVersion` that fall on the old-client side for
Forever (16001 < 30000/50000/110000): `mountcount` (`functions.lua:3519`),
`scenario` (`:6505`/`:6597`), `LoremasterCheck` (`RXPGuides.lua:2590`),
`BANK_CONTAINER` (`functions.lua:22`), `GetSubZoneId` (`functions.lua:4538`),
`aura` combat guard only on ≥ 120000 (`functions.lua:7903`).
This list is a sample, not a full classification: the same six files
hold about 40 `gameVersion` comparisons (search `gameVersion *[<>]`).
Others that put Forever on the old-client side include the riding-skill
branch (`RXPGuides.lua:492`, `< 20000`; its counterpart at
`functions.lua:3484` needs `>= 30000`), `RXPGuides.lua:854`, `:891`,
the quest-reward recommendation branches (`:992`, `:1002`), `:1246` and
`:1556` (`< 40000`), `functions.lua:92-97`, and the Stormwind and
Eastern Plaguelands transforms (`map.lua:1540-1561`, A8.2). Tests of
`WOW_PROJECT_ID == WOW_PROJECT_MAINLINE` (`functions.lua:2608`, `:6916`;
`RXPGuides.lua:1801`; `map.lua:1540`, `:1547`) are false on Forever if
the client reports the Camelot project ID, which needs the client.

---

## A10. How upstream's Forever guides are organised

### A10.1 Files

`Guides/GuideList-forever.xml` loads, in order: `Guides/Import.lua` (a
4-byte file containing `--`), `forever/RestedXP-Skyborne.lua`, four
Alliance files, `forever/Horde-01-12_Durotar.lua`,
`forever/Horde-01-14_Undead.lua`, `forever/Horde-1-12_Mulgore.lua`,
`forever/Horde-12-22_Barrens.lua`, four Mage files (`Alliance-Mage-1-12`, `Alliance-Mage-12-21`, `Horde-Mage-12-21`, `Alliance-ADV-AoE-Mage-1-22`), the nine
`forever/dungeon/*.lua` files, twelve `SurvivalGuide/*.lua` files,
`Classic-Attunements.lua` and `Classic-0.5.lua`. Translated copies are in
`lang/Guides-<locale>/GuideList-forever.xml` (`RXPGuides.toc:75-107`).

### A10.2 Horde headers

The guides in the four `Horde-*` speedrun files (the table and the Undead
and Mulgore guides below) all carry `#forever`, a bare `<< Horde` line
and `#version 11`. The Skyborne and Mage AoE guides differ; see below
the table.

Normal group **`RestedXP Forever Guide (H)`**, subgroup
`Speedrun Guide 1-22`, every guide has `#disabledungeons`:

| File:line | `#name` | `#displayname` | `#defaultfor` | `#next` |
|---|---|---|---|---|
| `forever/Horde-01-12_Durotar.lua:5` | 1-6 Durotar | — | Troll/Orc | 6-10 Durotar |
| `:1100` | 6-10 Durotar | — | Troll/Orc | 10-12 Durotar |
| `:3185` | 10-12 Durotar | — | Troll/Orc | `10-12 Tirisfal (Orc/Troll) << !Hunter !Shaman !Tauren !Skyborne`; `12-17 The Barrens << Orc Hunter/Troll Hunter/Orc Shaman/Troll Shaman` |
| `:3819` | 10-12 Tirisfal (Orc/Troll) | — | `!Hunter !Shaman !Tauren !Skyborne !Undead` | `12-14 Silverpine Forest << !Hunter !Shaman !Tauren !Skyborne !Undead` |
| `forever/Horde-01-14_Undead.lua:3326` | 12-14 Silverpine Forest | 13-15 … << Paladin | `!Hunter !Shaman !Tauren` | 12-17 The Barrens |
| `forever/Horde-12-22_Barrens.lua:5` | 12-17 The Barrens | 14-18 … << !Shaman !Hunter !Tauren; 15-18 … << Paladin | — | 17-22 Stonetalon/Barrens/Ashenvale |
| `:2557` | 17-22 Stonetalon/Barrens/Ashenvale | 18-22 … << !Shaman !Hunter !Tauren | — | **22-24 Hillsbrad** |

Other Horde guides in the same group: Undead `1-6`/`6-12 Tirisfal Glades`
(`#defaultfor Undead`), Mulgore `1-6`/`6-12 Mulgore` (`#defaultfor Tauren`),
Skyborne `1-9`/`9-13 Zephras Isle` (`#defaultfor Skyborne`). The Skyborne
guides are `#version 1` and have no bare `<<` line; they are placed per
faction by conditional `#group` lines instead
(`forever/RestedXP-Skyborne.lua:6-15`, `:3238-3250`). The Mage AoE
guides use group `RestedXP Horde Mage AoE`, `<< Horde Mage`,
`#version 1`, `#defaultfor none Horde Mage`
(`forever/Horde-Mage-12-21.lua:8-14`, `:712-718`).

`#next` targets that do not exist:

- **No guide named `22-24 Hillsbrad` exists in this checkout** (search of
  `Guides/` and `lang/` for `#name.*Hillsbrad`); the speedrun chain ends
  there (A6.5).
- The Mage AoE guide `17-21 Stonetalon/Barrens AoE` points at
  `21-30 Silverpine/Hillsbrad AoE` (`forever/Horde-Mage-12-21.lua:718`),
  which has no `#name` line anywhere under `Guides/` or `lang/`. This is
  not on the Troll Warrior path.

Display names. Several of these guides carry conditional `#displayname`
lines, and the first one whose condition applies wins (A2.1). For a
Troll Warrior `12-17 The Barrens` is shown as `14-18 The Barrens` and
`17-22 Stonetalon/Barrens/Ashenvale` as
`18-22 Stonetalon/Barrens/Ashenvale` (both
`<< !Shaman !Hunter !Tauren`, `forever/Horde-12-22_Barrens.lua:10`,
`:2562`). Guide lookups (`#next`, `#include`) use the `#name`, not the
display name; the configurator's level filter (A6.6) uses the display
name's range.

Step-level tags in these files that decide what a Forever player sees
(counts of live tag lines, comments excluded):

| File | `#hardcore` steps | `#softcore` steps |
|---|---|---|
| `forever/Horde-01-12_Durotar.lua` | 27 | 37 |
| `forever/Horde-01-14_Undead.lua` | 7 | 17 |
| `forever/Horde-1-12_Mulgore.lua` | 10 | 15 |
| `forever/Horde-12-22_Barrens.lua` | 7 | 8 |
| `forever/dungeon/Horde-12-22_Barrens.lua` | 7 | 7 |

On any game other than CLASSIC the engine clears `profile.hardcore` at
start-up (`RXPGuides.lua:1563-1564`) and forces every loaded guide to
softcore (`GuideWindow.lua:1865-1868`), so `HardcoreCheck`
(`RXPGuides.lua:2628-2634`) hides the `#hardcore` steps and shows the
`#softcore` ones (as read; untested in client). A guide author reading
these files should treat the `#hardcore` steps as never shown on
Forever.

### A10.3 Dungeon variants

Group **`RestedXP Forever Dungeon Guide (H)`**, subgroup
`Dungeon Guide 1-22`, **no `#disabledungeons`**:

- The 1–14 files are thin wrappers: the same `#name` and `#defaultfor` as
  the normal guide, the same `#next` except where the table below says
  otherwise, and one step containing `.enabledungeon <TAG>` lines and
  `#include RestedXP Forever Guide (H)\<name>`
  (`forever/dungeon/Horde-01-12_Durotar.lua:17-19`, `:33-35`, `:51-54`, `:69-71`;
  `forever/dungeon/Horde-01-14_Undead.lua:54-57`). The wrapper turns on the
  `.dungeon RFC`/`ROL` steps that the base guides already contain
  (`.dungeon` appears 15 times in `forever/Horde-01-12_Durotar.lua`, e.g.
  `:3630`) and that `#disabledungeons` hides in the normal group. Of
  those 15 lines, 9 are plain (`RFC` 5, `ROL` 4) and 6 are negated
  (`!RFC` 1, `!ROL` 5); a negated line marks a step that shows only when
  that dungeon is **off**, so the normal group shows the negated steps
  and the dungeon group shows the plain ones for the dungeons its
  wrapper enables (`RXPGuides.lua:2740-2746`).
- Why the wrappers work (as read): a step `#include` with no group part
  resolves against the including (top-level) guide's group, and one with
  a group part names it outright (`GuideWindow.lua:1651-1655`); included
  steps are filtered with `IsStepShown(step, currentGuide)`, that is,
  against the including guide (`GuideWindow.lua:1684`), so
  `DungeonCheck` looks up `addon.dungeonOverride` under the wrapper's
  group (`RXPGuides.lua:2724-2738`); `.enabledungeon` wrote that
  override at parse time under the group of the guide being parsed,
  which is the wrapper (`functions.lua:7651-7675`); and the include of
  `1-6 Durotar` is found because `FetchGuide` retries with the
  zero-padded name (`GuideWindow.lua:1779-1785`).
- Differences in `#next` between the dungeon wrappers and the speedrun
  guides of the same name:

  | Dungeon guide (file:line) | Dungeon `#next` | Speedrun `#next` |
  |---|---|---|
  | 10-12 Durotar (`forever/dungeon/Horde-01-12_Durotar.lua:47-48`) | Hunter/Shaman → `12-16 The Barrens` | Hunter/Shaman → `12-17 The Barrens` |
  | 12-14 Silverpine Forest (`forever/dungeon/Horde-01-14_Undead.lua:51`) | `12-16 The Barrens` | `12-17 The Barrens` |
  | 6-12 Mulgore (`forever/dungeon/Horde-1-12_Mulgore.lua:31`) | `12-16 The Barrens` | `12-17 The Barrens` (`forever/Horde-1-12_Mulgore.lua:486`) |
  | 9-13 Zephras Isle (`forever/dungeon/RestedXP-Skyborne.lua:34-36`) | `13-15 Westfall << Alliance`; `12-14 Silverpine Forest << Horde !Hunter`; `12-16 The Barrens << Horde Hunter` | `13-15 Westfall << Alliance !Hunter`; `14-16 Darkshore << Alliance Hunter`; `12-14 Silverpine Forest << Horde !Hunter`; `12-17 The Barrens << Horde Hunter` (`forever/RestedXP-Skyborne.lua:3246-3249`) |

  One wrapper was not adjusted: dungeon `6-12 Tirisfal Glades` keeps
  `#next 12-14 Silverpine Forest; 12-17 The Barrens`
  (`forever/dungeon/Horde-01-14_Undead.lua:31`), and no guide named
  `12-17 The Barrens` exists in the dungeon group. That second entry is
  only a fallback (the first entry exists in the group), but it is a
  second `#next` name with no target in its own group, besides
  `22-24 Hillsbrad`. The dungeon `12-14 Silverpine Forest` header also
  carries a stray `#era/som` tag (`:48`, written `#era/som--h`), which
  the season filter reads only when the season setting is 1
  (`RXPGuides.lua:2611-2614`).
- `forever/dungeon/Horde-12-22_Barrens.lua` is full content (737 steps,
  35 `.dungeon`, 3 `.enabledungeon`, no `#include`) with its own chain:
  `12-16 The Barrens` → `16-17 Ragefire Chasm` → `17-18 Ruins of Lordaeron`
  → `18-21 The Barrens` → `21-22 Wailing Caverns` → `22-24 Hillsbrad`
  (lines 8/15, 1684/1689, 2180/2185, 2716/2721, 4520/4521). 34 of its lines
  are `.dungeon DM`.
- Forever dungeon tags (with area IDs, upstream data) are in
  `DB/forever/db.lua:123-152`, including the Forever dungeons `HOT`, `ROL`,
  `ES`, `COD`, `TDC`, `KS`, `AP`, `BH`, `TST`; aliases at `:154-171`.
- Whether a dungeon step shows is decided by `addon.dungeonOverride[group]`
  (from `.enabledungeon`), else `#disabledungeons`, else the player setting
  `profile.dungeons[tag]` (`RXPGuides.lua:2724-2739`).

### A10.4 SurvivalGuide

`Guides/SurvivalGuide/H-*.lua` carry `#hardcore` and `#classic` but not
`#forever`, group `RestedXP Survival Guide (H)`
(e.g. `H-Classic-Horde-01-13_Durotar.lua:5`). None of the twelve files
contains `#forever`, so from source the pre-scan drops them on Forever
(A2.3, conditional on `addon.game` being `"FOREVER"` and on the load
order; untested in client). Same for `Classic-Attunements.lua` (11
guides) and `Classic-0.5.lua` (4 guides) (`#classic`, group
`RestedXP Endgame Guides`, no `#forever`).

### A10.5 What a fresh Horde Troll is offered (inferred; confirm in client)

- Active, non-low-priority guides in `RestedXP Forever Guide (H)` for a
  Troll Warrior: `01-06 Durotar`, `06-10 Durotar`, `10-12 Durotar`,
  `10-12 Tirisfal (Orc/Troll)`, `12-14 Silverpine Forest`,
  `12-17 The Barrens`, `17-22 Stonetalon/Barrens/Ashenvale`. Undead,
  Mulgore and Skyborne guides fail `#defaultfor` and are low priority.
  This follows from the `#defaultfor` lines read by hand
  (`forever/Horde-01-12_Durotar.lua:14`, `:1109`, `:3194`, `:3828`;
  `forever/Horde-01-14_Undead.lua:13`, `:717`, `:3332`;
  `forever/Horde-1-12_Mulgore.lua:15`, `:485`) and the keyword rules of
  A3.2. Of these conditions, `Troll/Orc` and
  `!Hunter !Shaman !Tauren !Skyborne !Undead` are among the examples
  verified (harness) in A3.1; the others were evaluated by reading only.
- No guide is loaded automatically. At first login of a level-1
  character the guide configurator opens and the player chooses (A6.6).
  Under "Open World Guide" the list is expected to hold the guides of
  the group whose display-name level range includes level 1:
  `1-6 Durotar`, and also the low-priority `1-6 Tirisfal Glades`,
  `1-6 Mulgore` and Skyborne `1-9` guides if the group lookup returns
  low-priority entries (the lookup `GetActiveGuidesByGroupNameOrId` was
  not traced). `1-6 Durotar` is expected to be offered and to be the
  recommended entry for a level-1 Troll: by the zone-name rule if the
  client's zone text is "Durotar", otherwise through the
  `addon.defaultGuide` or `#defaultfor` fallbacks. Which entry is
  highlighted is not confirmed from source; it needs the client (A11
  item 9).
- `addon.defaultGuide` itself = first active guide by sorted name =
  `01-06 Durotar` (A6.6), displayed as `1-6 Durotar`
  (`GuideLoader.lua:1292-1293`). On Forever it only feeds the
  configurator's recommendation.
- Route for a Troll Warrior, by `#name`: 1-6 Durotar → 6-10 Durotar →
  10-12 Durotar → 10-12 Tirisfal (Orc/Troll) → 12-14 Silverpine Forest →
  12-17 The Barrens → 17-22 Stonetalon/Barrens/Ashenvale → (missing
  22-24 Hillsbrad). The last two appear in the menu and window as
  `14-18 The Barrens` and `18-22 Stonetalon/Barrens/Ashenvale` (A10.2).
- The dungeon group offers the same start with RFC/ROL detours and the
  RFC → ROL → WC Barrens chain above.

---

## A11. Could not determine / needs the game client

1. The interface number Forever returns from `GetBuildInfo()` (the code
   expects 16000–19999; CLAUDE.md says 16001).
2. That guide files run before `OnInitialize`, so that `addonLoaded` is
   `nil` when they call `RegisterGuide`. Given that, and item 1, the
   source settles the rest: the guides are queued, the pre-scan requires
   `#FOREVER`, and the `#classic`-only SurvivalGuide, Attunement and 0.5
   guides contain no `#forever` and are dropped (A2.3, A10.4). The guide
   list in the in-game dump confirms it.
3. The race token `UnitRace` returns for Skyborne (guides assume
   `Skyborne`), and that Troll returns `Troll`.
4. Availability on Forever of: `C_GossipInfo.GetOptions` (upstream guide
   usage is not evidence either way, A5.3),
   `GetAchievementInfo`, `C_TaskQuest`, `C_PlayerChoice`,
   `C_ScrappingMachineUI`, `C_ChromieTime`, `C_SuperTrack`,
   `C_PlayerInfo.CanPlayerEnterChromieTime` (fresh/veteran filter),
   `C_EventUtils.IsEventValid` and the events it gates
   (`UNIT_QUEST_LOG_CHANGED`, `STOP_MOVIE`, `GOSSIP_CONFIRM`,
   `PLAYER_INTERACTION_MANAGER_FRAME_SHOW`, `LEARNED_SPELL_IN_TAB`,
   `ZONE_CHANGED_INDOORS`, `PLAYER_TALENT_UPDATE` and
   `ACTIVE_TALENT_GROUP_CHANGED` (`functions.lua:211-214`),
   `BAG_CONTAINER_UPDATE` (`InventoryManager.lua:100`), and
   `PLAYER_INTERACTION_MANAGER_FRAME_HIDE`, which is enabled when
   `GOSSIP_CONFIRM` is valid, `functions.lua:168-170`), `C_Seasons`,
   `C_GameRules`. Also whether the client reports
   `WOW_PROJECT_ID == WOW_PROJECT_CAMELOT`, which the
   `WOW_PROJECT_MAINLINE` tests in A9 and the HereBeDragons Forever
   branches in A8.1 depend on.
5. Whether `UnitPosition` (via HereBeDragons) returns values on Forever in
   the open world and how it behaves in Forever's new zones and dungeons;
   and what `C_Map.GetMapInfo`, `C_Map.GetWorldPosFromMapPos` and
   `C_Map.GetMapWorldSize` return for the new maps (2521 and the
   unpublished IDs of Riverglades/Shen'dralas), since HereBeDragons
   builds its zone data from those calls at load and ships no table
   (A8.1). Also the axis order of `UnitPosition` against recorded
   `.goto` world coordinates, which A8.2 derives from source only.
6. UiMapIDs for Forever-only zones other than Zephras Isle (2521, the
   only one in `addon.mapId`, `DB/forever/db.lua:96`).
7. Whether `C_Secrets.ShouldAurasBeSecret()` / `addon.IsSecretValue` make
   `.aura` and `.cooldown` inert on Forever in practice. Not
   investigated from source beyond the guards cited in A5.3.
8. The XP rate value `settings:DetectXPRate` sets on Forever (affects all
   `#xprate` steps) and the season value (`C_Seasons`) that drives the 89
   live `#season` tags in Forever guides and the `engrave` gate. All 89
   are in Alliance files (`Alliance-1-10_NightElf` 2,
   `Alliance-1-13_Human` 30, `Alliance-1-14_DwarfGnome` 35,
   `Alliance-ADV-AoE-Mage-1-22` 20, `dungeon/Alliance-1-10_NightElf` 2;
   one further `#season` line is commented out). The Horde speedrun,
   dungeon and Skyborne files contain no `#season`, `#xprate` or
   `#phase` tag, so this item does not affect the Troll Warrior slice;
   the only such tag in a Horde file is one `#phase 3-6` in the Mage AoE
   guide (`forever/Horde-Mage-12-21.lua:22`).
9. Which entry the v2 configurator highlights as recommended for a fresh
   character, and that it opens at all at first login. From source the
   player picks the guide from a list and nothing is auto-loaded (A6.6);
   the highlight depends on the zone text the client returns.
10. Runtime behaviour of functions marked "runtime not fully traced"
    (`ingamewaypoint`, `destroy`, `totalbagslots`, `dualspec`, `requires`),
    and the "Arguments" and "Meaning" columns of the A5.3 rows listed
    there as not confirmed from source (these can be settled by reading
    the function bodies; the client is needed only for their effect).
11. Whether the element-drop behaviours read in A4.4 and A5 hold in the
    client: a gated or unknown `.tag` leaving its `>>text` as a plain
    line, quest skip conditions running only at step activation, and
    `.timer` starting only under the parents listed in A5.3.

---

# Part B — load order, detection, saved variables, settings, comms, import, data, modules, hooks

## B1. Load order on Forever (`camelot`)

### TOC files

| File | Purpose (from its contents) |
|---|---|
| `RXPGuides.toc` | Multi-flavour TOC. Line 1 `## Interface: 11509, 38002, 50504, 120007, 120105, 16001` (RXPGuides.toc:1) — **16001 is present**. Per-flavour overrides `Interface-Mists: 50504`, `Interface-TBC: 20506`, `Interface-Classic: 11509` (RXPGuides.toc:2-4). File lines are gated with `[AllowLoadGameType …]`. This is the only TOC that names `camelot`. |
| `RXPGuides_TBC.toc` | `## Interface: 20506`; no `AllowLoadGameType` tags; loads `DB/tbc.xml`, TBC guide lists, TBC talents. |
| `RXPGuides_Vanilla.toc` | `## Interface: 11509`; loads `DB/classic.xml`, classic lists (RXPGuides_Vanilla.toc:25-77). |

Common directives in `RXPGuides.toc`: `## Title: RestedXP Guides` (:5), `## Version: @project-version@` (:9),
`## OptionalDeps: Questie, RXPGuides_Themes` (:21), `## SavedVariables: RXPData, RXPDB, RXPSettings, RXPString` (:22),
`## SavedVariablesPerCharacter: RXPCData, RXPCTrackingData, RXPCComms, RXPCSettings` (:23),
`## X-Curse-Project-ID: 486246` (:24), `## X-Wago-ID: ZKbebq61` (:25). The TBC and Vanilla TOCs carry the same
OptionalDeps/SavedVariables/IDs lines.

### Exact file order for `camelot`

Lines without a tag load for every game type. Lines whose tag omits `camelot` are skipped. Lines starting `#` are
comments (e.g. RXPGuides.toc:73, :78).

1. `libs\embeds_Mainline.xml` [standard,camelot] (RXPGuides.toc:27) →
   `compatibility.lua`, `LibStub\LibStub.lua`, `CallbackHandler-1.0\CallbackHandler-1.0.lua`,
   `mainline\LibUIDropDownMenu\LibUIDropDownMenu.xml` (→ `LibUIDropDownMenu.lua`; the templates include is commented out),
   `AceEvent-3.0` (→ `AceEvent-3.0.lua`), `AceDB-3.0\AceDB-3.0.lua`, `AceAddon-3.0` (→ `.lua`),
   `AceGUI-3.0` (→ `AceGUI-3.0.lua` + 22 widget files, AceGUI-3.0.xml:3-27),
   `mainline\AceConfig-3.0\AceConfig-3.0.xml` (→ Registry, Cmd, Dialog, then `AceConfig-3.0.lua`; the `libs\AceConfig-3.0` copy is **not** used on camelot),
   `AceComm-3.0` (→ `ChatThrottleLib.lua`, `AceComm-3.0.lua`), `AceSerializer-3.0`, `AceConsole-3.0`, `AceLocale-3.0`,
   `AceDBOptions-3.0`, `HereBeDragons\HereBeDragons-2.0.lua`, `HereBeDragons\HereBeDragons-Pins-2.0.lua`,
   `plc\base64.lua`, `LibDeflate\lib.xml` (→ `LibDeflate.lua`), `LibCandyBar-3.0\lib.xml` (→ `.lua`),
   `LibDataBroker-1.1\LibDataBroker-1.1.lua`, `LibDBIcon-1.0\lib.xml` (→ `.lua`) (embeds_Mainline.xml:3-26).
   (`libs\embeds.xml` is tagged vanilla,tbc,wrath,cata,mists — skipped, RXPGuides.toc:28.)
2. `locale\locales.xml` (:29) → `enUS, ptBR, esES, frFR, zhCN, zhTW, deDE, koKR, ruRU, NPCnames` .lua (locales.xml:2-11).
   `locale/localization_strings.lua` exists but is not listed, so never loads.
3. `UI\includes.xml` (:30) → `V2\Manifest.xml` (includes.xml:2; the file on disk is `manifest.xml`) →
   `ScrollBarTemplate.xml`, `Core.lua`, `AuctionHouse.lua`, `GuideConfigurator.lua`, `GuideImporter.lua` (manifest.xml:2-6).
   These run **before** `Locale.lua` creates the AceAddon (UI/V2/Core.lua:9 "AceAddon doesn't exist yet").
4. `Locale.lua`, `Themes.lua`, `Communications.lua`, `RXPGuides.lua`, `GuideWindow.lua`, `Help.lua`, `SettingsPanel.lua` (:32-38).
5. `DB/forever.xml` [camelot] (:46) → `DB/shared.lua`, `DB/forever/flightData.lua`, `quest.lua`, `spells.lua`,
   `rares.lua`, `db.lua`, `dangerousMobs.lua`, `StatWeights.lua`, `SpiritHealerDB.lua`, then `DB/questDB.lua` (forever.xml:3-13).
6. `HSBatching.lua`, `QuestLog.lua`, `ActiveItemFrame.lua`, `LevelingTracker.lua`, `Timers.lua`, `Targeting.lua`,
   `Tips.lua`, `InventoryManager.lua` (:48-55).
7. `map.lua`, `functions.lua`, `GuideLoader.lua` (:58-60).
8. `Guides/GuideList-forever.xml` [camelot] (:66) → `Guides/Import.lua` (1 line, `--`; listed in .gitignore:2 under "local import testing" but tracked in this checkout, as is `lang/Guides-deDE/Import.lua`),
   13 files in `Guides/forever/`, 9 in `Guides/forever/dungeon/`, 12 in `Guides/SurvivalGuide/`,
   `Guides/Classic-Attunements.lua`, `Guides/Classic-0.5.lua` (GuideList-forever.xml:2-45).
9. Translated lists, all [camelot]: `lang/Guides-zhCN/GuideList-forever.xml` (:75), `-deDE` (:83), `-esES` (:91),
   `-frFR` (:99), `-ptBR` (:107). Each loads its own `Import.lua` plus the same 36 relative paths as step 8
   (e.g. lang/Guides-deDE/GuideList-forever.xml:3-39).
10. `Talents.lua` [cata,vanilla,camelot,tbc] (:112); `Guides/Talents/classic.xml` [vanilla,camelot] (:115) → 9 `classic-<class>.lua` files (classic.xml:2-10).
11. `ItemUpgrades.lua` [tbc,vanilla,camelot,cata] (:117).
12. `CptStadicsVendorTreasures.lua` [vanilla,camelot,tbc,wrath] (:119).

`Bindings.xml` is not in any TOC; the client loads it by file name (inferred: standard client behaviour, not in source).

The manifests use three different path conventions. `DB/forever.xml`, `Guides/GuideList-forever.xml` and
`Guides/Talents/classic.xml` give script paths relative to the addon root (e.g. `<Script file="DB/shared.lua"/>`,
forever.xml:3; `Guides/forever/…`, GuideList-forever.xml:3). The `lang/` lists give paths relative to the XML file's own
directory (e.g. `<Script file="forever\RestedXP-Skyborne.lua"/>`, lang/Guides-deDE/GuideList-forever.xml:4).
`UI/V2/manifest.xml` loads its Lua files with `<Include file="Core.lua" />` rather than `<Script>` (manifest.xml:3-6).
How the client resolves each form is not in source (B17 item 14).

Several files that load on camelot return immediately at runtime (see B2/B13): `DB/forever/rares.lua:8-10`,
all nine `Guides/Talents/classic-*.lua:3`, `ItemUpgrades.lua:6`.

### Installed CurseForge build vs this repo (listing and TOC only)

Path: `C:\Program Files (x86)\World of Warcraft\_forever_\Interface\AddOns\RXPGuides\` (only addon in that AddOns folder).

- Version in installed TOCs: `## Version: v4.11.35` (repo: `@project-version@`).
- Installed `RXPGuides.toc` has the **same line 1** (`… 16001`) but **lacks** the `Interface-Mists/-TBC/-Classic`
  lines (diff of the two TOCs). The installed build has an extra `RXPGuides_Mists.toc` (`## Interface: 50504`, same
  body). Inferred: the packager's `enable-toc-creation: yes` (.pkgmeta:6) split the flavour lines into per-flavour TOCs.
- Files only in installed build: `CHANGELOG.md`, `RXPGuides_Mists.toc`.
- Files only in repo: `.editorconfig`, `.github/workflows/package.yml`, `.gitignore`, `.pkgmeta`, `.vscode/*`,
  `Guides/Retail/.vscode/settings.json`, `Scripts/*` (7 files), `readme.md`, plus our handoff/tooling files
  (`CLAUDE.md`, `HANDOFF_README.md`, `KICKOFF_PROMPT.md`, `package*.json`, `tsconfig.json`, `tools/**`).
- 229 files present in both differ in size (e.g. `RXPGuides.lua`, `GuideWindow.lua`, `SettingsPanel.lua`,
  `functions.lua`, `UI/V2/GuideConfigurator.lua`, `DB/forever/flightData.lua`, most Forever guide files). The installed
  build is a different upstream release than commit `22e6ce26`; contents were not compared (by instruction).

---

## B2. Forever detection

### How the flavour is set

- `addon.gameVersion = select(4, GetBuildInfo())` (RXPGuides.lua:168-169).
- `addon.game` is derived **only from the interface number**, not from `WOW_PROJECT_ID` (RXPGuides.lua:185-212):
  `>60000` RETAIL, `>50000` MOP, `>40000` CATA, `>30000` WOTLK, `>20000` TBC,
  **`>=16000 and <20000` → `"FOREVER"`, maxLevel 60, `enabledLocale.zhCN = true`** (:204-207), else CLASSIC.
- `WOW_PROJECT_CAMELOT` is never defined in the addon; it is read as a client global in RXPGuides.lua:585,
  Targeting.lua:243, functions.lua:259 and HereBeDragons-2.0.lua:19. Its numeric value cannot be read from source.
- `addon.player.name` on Forever is `"<first> <last>"` from both `UnitName` returns (RXPGuides.lua:253-258).
- Embedded libraries also detect Forever: AceDB-3.0.lua:264-275 (interface 16000–20000 → realm key becomes
  `"Hardcore"`, `"RP"`, `"PvP"` or `"PvE"` from `C_GameRules`), HereBeDragons-2.0.lua:19,102,253,293.
- Guides opt in with a `#forever` header line (e.g. Guides/forever/Horde-01-12_Durotar.lua:6; 480 occurrences in the
  camelot-loaded guide set). GuideLoader treats FOREVER as accepting `guide.forever` or `guide.classic`
  (GuideLoader.lua:1171) — details in Part A.

### Forever branches outside the DSL files

| Location | Effect |
|---|---|
| RXPGuides.lua:123 | `SendEvent` also forwards to `_G.ForeverAuras.ScanEvents` if present (WeakAuras fork) |
| RXPGuides.lua:253-258 | player name = first + last name |
| RXPGuides.lua:585-590, 630-635 | trainer auto-buy: skip when trainer title equals pet name; buy spells back-to-front |
| RXPGuides.lua:1397-1398 | commented-out TODO "Fix the dungeon selection for Camelot" |
| RXPGuides.lua:1545-1553 | if `lootSparkle` on, writes 5 graphics CVars (`outlineModeShowLootEffectWhenDisabled`, `graphicsOutlineMode`, …) |
| RXPGuides.lua:2495 | Aldor/Scryer check always true |
| RXPGuides.lua:2520-2525 | default phase 5 and **forces** `profile.phase = 5` whenever it is set |
| SettingsPanel.lua:171 | default `questLogSize` 40 |
| SettingsPanel.lua:266-268 | does not clear `RXPCData.localDB` at this point on Forever or for beta players (`addon.player.beta`); other flavours clear it here. In practice `addon:OnInitialize` has already cleared it at every login when both `RXPCData` and `RXPData` exist (RXPGuides.lua:1493-1496), and `CreateMetaDataTable` clears it again when it rebuilds (RXPGuides.lua:1289-1292). It is written only when `addon.saveSettingsLocally` is set (SettingsPanel.lua:287-292), which happens only when `RXPCData` existed at login without `RXPData` (RXPGuides.lua:1493-1498, 1622-1624) |
| SettingsPanel.lua:295-301 | back-fills nil profile keys from defaults (Forever only) |
| SettingsPanel.lua:847 | `lootSparkle` toggle shown only on Forever |
| SettingsPanel.lua:1355 | hides a Mainline-only option on Forever |
| SettingsPanel.lua:1456 | hides "recommended dungeons" button unless debug |
| QuestLog.lua:27 | quest log size 40 |
| Targeting.lua:57-66 | target buttons add `/tm !N` marker macro text (Forever uses `!`) |
| Targeting.lua:243-246 | macro appends `/tm !7`, max 223 chars (also Mainline) |
| Targeting.lua:530, 985 | never calls `SetRaidTarget` automatically |
| DB/forever/rares.lua:7-10 | returns when `gameVersion >= 11508`, with the comment "As of 1.15.8 TargetUnit now fires ADDON_ACTION_FORBIDDEN at execution"; so `addon.rares` is nil and Targeting does not load rares (Targeting.lua:154-157). The proximity scan itself is gated separately (B18 row A1) |
| InventoryManager.lua:997 | uses Default bag adapter when `ContainerFrame_UpdateAll` exists |
| UI/V2/GuideConfigurator.lua:12-16 | configurator supported on CLASSIC, TBC, FOREVER |
| UI/V2/GuideConfigurator.lua:1160-2137 | Forever-only flows: "Dungeon Guide" / "Open World Guide" cards, pages `foreverDungeonOptions*`, `foreverOpenWorld*`, group names `RestedXP Forever Dungeon Guide (A/H)` |
| DB/forever/*.lua:3 | every Forever data file returns unless `addon.game == "FOREVER"` (spells.lua also skips season 2) |
| DB/forever/db.lua:35-39 | default guide group `RestedXP Forever Guide (H)` / `(A)` |
| functions.lua:259 | Mainline POI icons for goto/home/deathskip (Part A file) |

Note also code that excludes Forever implicitly by testing `addon.game == "CLASSIC"`: ItemUpgrades.lua:6,
all `Guides/Talents/classic-*.lua:3`, RXPGuides.lua:1563-1564 (hardcore forced false), Talents.lua:605/673.

### Per-file counts (non-lib, non-guide, non-locale Lua; case-insensitive)

`forever|camelot|16001` / `gameVersion|GetBuildInfo` / `addon.game|self.game` / `WOW_PROJECT_ID`:

| File | forever | gameVer | addon.game | WOW_PROJECT_ID |
|---|---|---|---|---|
| RXPGuides.lua | 11 | 33 | 18 | 3 |
| SettingsPanel.lua | 7 | 20 | 25 | 1 |
| UI/V2/GuideConfigurator.lua | 38 | 0 | 15 | 0 |
| Targeting.lua | 7 | 4 | 4 | 1 |
| GuideLoader.lua (Part A) | 6 | 0 | 12 | 0 |
| functions.lua (Part A) | 2 | 13 | 4 | 3 |
| map.lua (Part A) | 0 | 5 | 0 | 2 |
| Talents.lua | 0 | 2 | 15 | 0 |
| ItemUpgrades.lua | 0 | 0 | 5 | 0 |
| DB/questDB.lua | 0 | 4 | 1 | 0 |
| GuideWindow.lua | 0 | 0 | 3 | 0 |
| Tips.lua | 0 | 3 | 0 | 0 |
| QuestLog.lua | 1 | 0 | 2 | 0 |
| InventoryManager.lua | 1 | 1 | 1 | 0 |
| ActiveItemFrame.lua | 0 | 0 | 1 | 0 |
| Communications.lua | 0 | 1 | 0 | 0 |
| CptStadicsVendorTreasures.lua | 0 | 1 | 0 | 0 |
| DB/forever/db.lua | 5 | 0 | 1 | 0 |
| DB/forever/rares.lua | 1 | 1 | 1 | 0 |
| DB/forever/{SpiritHealerDB,StatWeights,dangerousMobs,flightData,quest,spells}.lua | 1 each | 0 | 1 each | 0 |

Locale files match "Forever" only in group-name translations (e.g. locale/deDE.lua:353-356); frFR.lua:77 and
NPCnames.lua:10326 match "camelote/Camelot" as ordinary words.

---

## B3. Embedded libraries loaded on Forever

Order and paths per embeds_Mainline.xml:3-26. "No licence statement in file" = no `licen*`/copyright line found.

| Library | Version constant | Licence text in its own files |
|---|---|---|
| `libs/compatibility.lua` (addon code, 34 lines) | — | none. Defines `addon.IsSecretValue` (:3-5, wraps `issecretvalue`), `addon.GetUnitName` (:7-13), `securecallfunction` shim (:15-17), and a `Settings` shim only when `C_SettingsUtil` is absent (:20-34) |
| LibStub | `"LibStub", 2` (LibStub.lua:3) | "LibStub is hereby placed in the Public Domain" (LibStub.lua:2) |
| CallbackHandler-1.0 | MINOR 8, `$Id … 1298 2022-12-12` (:1-2) | no licence statement in file |
| LibUIDropDownMenu-4.0 (`libs/mainline`) | `90000 + Rev 135`, `$Id … 135 2024-02-05` (:1, :20-21) | no licence statement in file |
| AceEvent-3.0 | 4 (:15) | none |
| AceDB-3.0 | 36, `$Id … 1414 2026-09-18` (:43-44) | none |
| AceAddon-3.0 | 13 (:33) | none |
| AceGUI-3.0 (+22 widgets) | 41 (:28) | none |
| AceConfig-3.0 (mainline copy) | 3 (:18); Registry 22 (:14); Cmd 14 (:19); Dialog 93, `$Id 1409 2026-09-03` (:4,:10) | none |
| AceComm-3.0 | 14 (:23) | none |
| ChatThrottleLib | `CTL_VERSION = 32` (:26) | "LICENSE: ChatThrottleLib is released into the Public Domain" (ChatThrottleLib.lua:23) |
| AceSerializer-3.0 | 5 (:14) | none |
| AceConsole-3.0 | 7 (:13) | none |
| AceLocale-3.0 | 6 (:5) | none |
| AceDBOptions-3.0 | 15 (:5) | none |
| HereBeDragons-2.0 / -Pins-2.0 | 35 / 17 (:3 each) | none in the .lua files; the unloaded `HereBeDragons.toc` says `## X-License: BSD` (:7) and `## Version: 2.18-release` (:9) |
| plc/base64.lua | — | "Copyright (c) 2015 Phil Leblanc -- see LICENSE file" (:3). `libs/plc/LICENSE` is MIT-style permission text, licence name not stated (:1-22). **Modified by RestedXP**: `local _,addon = ...` (:1) and `addon.read = decode` (:56) |
| LibDeflate | "LibDeflate 1.0.2-release" (:2) | `@license zlib License` (:9) and zlib text (:30ff). **Conflict:** `libs/LibDeflate/LICENSE.txt` is the GNU **LGPL v3** text (LICENSE.txt:1-5). Flag for the licence sweep |
| LibCandyBar-3.0 | 104 (:24) | none |
| LibDataBroker-1.1 | 4 (:5) | none |
| LibDBIcon-1.0 | 52 (:9) | none |

---

## B4. Saved variables

All eight are declared in RXPGuides.toc:22-23 (account: first four; per-character: last four).

| Variable | Scope | AceDB? | Initialised / written | Holds |
|---|---|---|---|---|
| `RXPDB` | account | yes, `AceDB:New("RXPDB", {profile={guides={}, reports={splits={}}}}, 'global')` (RXPGuides.lua:1505-1509): every character uses profile `"global"` | written by import cache (`addon.db.profile.guides[...]`, GuideLoader.lua:484, 493), import header (GuideLoader.lua:1673-1675), level-splits import (`ImportSplits`, LevelingTracker.lua:1383-1400; B7); when the major game version changes only the cached guide table `profile.guides` is emptied, `reports.splits` and the rest are kept (RXPGuides.lua:1532-1538) | imported guides stored as deflate-compressed binary strings (GuideLoader.lua:482, 490), so they are not readable text in the SavedVariables file; `guideContent/guideLength/guideId` of last import string; imported level-split reports. Quirk: the login loop reassigns its loop variable `key` (GuideLoader.lua:881-885) before using it to delete a failed entry (:941), so the delete can address a different key than the entry that failed |
| `RXPData` | account | no (plain table) | created `RXPData = RXPData or {}` (RXPGuides.lua:1510); keys set 1511-1538, 1569-1571, 1769-1770 | `maxLoadTime`, `realmData[realm]`, `questNames` (+locale), `gameVersion`, `trainGenericSpells`, `release`, `cacheVersion`, `defaultProfile` (SettingsPanel.lua:3656), **`cache` = either the raw second return of `BNGetInfo` or a 16-byte key table derived from it**: the importer UI stores the raw value when `cache` is empty (`_, RXPData.cache = _G[…]()`, UI/V2/GuideImporter.lua:601-604), while `ReadCacheData` stores the mixed 16-byte table (GuideLoader.lua:618) and reuses whatever is already there when the call returns nothing (:593-594). Either form is written to disk in the account file; plus ~15 legacy keys read only by `MigrateLegacySettings` (SettingsPanel.lua:352-510) |
| `RXPSettings` | account file, profile per character by default | yes, `AceDB:New("RXPSettings", RXPData.defaultProfile or RXPCData.localDB or settingsDBDefaults)` (SettingsPanel.lua:270); profile callbacks :272-274; `addon.settings.profile` = live profile (:275) | written by every options setter (SettingsPanel.lua:533-535) | all user settings (defaults SettingsPanel.lua:127-258). Note: when `RXPData.defaultProfile` or `RXPCData.localDB` exists, the hard-coded defaults table is **not** passed to AceDB; Forever back-fills nil keys (:294-302) |
| `RXPString` | account | no | **never written in this checkout**; read once: `local string = addon.string or RXPString` (GuideLoader.lua:814) | an import string; if its header differs from the stored one, the import runs automatically at login (GuideLoader.lua:815-877). `addon.string` is never assigned either. Inferred: filled by something outside the game client |
| `RXPCData` | character | no | `RXPCData = RXPCData or {}` (RXPGuides.lua:1512) plus many keys (1513-1568); referenced on 216 lines in 17 files | guide progress (`currentStep`, `currentStepId`, `guideProgress`, `stepSkip`, `completedWaypoints`), `currentGuideName/Group`, caches (`questNameCache`, `questObjectivesCache`, `guideMetaData`), `flightPaths`, `exploredZones`, `discardPile`, `activeTalentGuide`, `itemUpgradeAHCache`, `localDB` (settings copy, written only when `addon.saveSettingsLocally` is set, SettingsPanel.lua:287-292; normally cleared at login, see B2), `GA` (Gold Assistant mode flag, B13) |
| `RXPCTrackingData` | character | yes, `AceDB:New("RXPCTrackingData", {profile={levels={}, levelsArchive={}}})` (LevelingTracker.lua:57-58), only when `enableTracker` (RXPGuides.lua:1594-1596) | levelling tracker | per-level timing data, archive keyed by GUID fragment (LevelingTracker.lua:63-75) |
| `RXPCComms` | character | yes, `AceDB:New("RXPCComms", {profile={announcements={}, players={}}})` (Communications.lua:39-41) | comms | party members seen (`players[name]` with class/level/xp/time), sent-announcement de-dup table (Communications.lua:355-361) |
| `RXPCSettings` | character | no (legacy AceDB data) | **never written**; read once to migrate pre-4.5.10 per-character settings into `RXPSettings` (SettingsPanel.lua:510-529) | legacy profiles |

AceDB profile keys use `charKey = UnitName("player") .. " - " .. realmKey` (AceDB-3.0.lua:276); on Forever `realmKey` is
the ruleset name, not the realm (AceDB-3.0.lua:264-275). Inferred consequence: two same-named characters on different
realms of the same ruleset share a settings profile key.

---

## B5. Global footprint

### Things a text search for "RXP" finds
- Tables: `_G.RXPGuides` (RXPGuides.lua:223-225, unconditional overwrite), `RXP = addon` (RXPGuides.lua:2771, "debug purposes"), `_G.RXPGuides.RegisterGuide/ImportGuide` (GuideLoader.lua:1389-1394), `_G.RXPGuides.talents` (Talents.lua:1415), `_G.RXPV2GuideWindow` (UI/V2/Core.lua:1480), `_G.RXPActivePartyStepsFrame` (set through `_G[frameName]` at GuideWindow.lua:2815-2816, cleared at :3608-3609; a search for the literal `_G.RXPActivePartyStepsFrame` finds only the clear), `_G["RXPActiveStepsFrame" .. player]` (set for the player's own name at GuideWindow.lua:3037-3039; cleared for departed party members' names, which arrive over addon messages, at :3585-3598), optional inputs `_G.RXPOnInitialize` (RXPGuides.lua:1573-1575) and `_G.RXPGuides_Themes` (Themes.lua:320-325, consumed then wiped).
- Named frames (CreateFrame second arg): `RXPFrame`, `RXPG_MenuFrame` (GuideWindow), `RXPItemFrame`, `RXPTELEPORTHOME`, `RXPTELEPORTTO` (ActiveItemFrame), `RXPTargetFrame`, `RXPTargetFrame_EnemyButton<n>`, `RXPTargetFrame_FriendlyButton<n>` (Targeting.lua:1174, 1243), `RXPDeleteJunk`, `RXPInventory_DeleteJunk`, `RXPJunkHandler` (InventoryManager), `RXPLevelSplits`, `RXPG_LevelMenuFrame`, `RXPG_SplitsMenuFrame` (LevelingTracker), `RXPQuestLogCleanupButton` (QuestLog), `RXPGuidesTrainerFrame` (RXPGuides.lua), `RXP_MMMenuFrame` (SettingsPanel.lua:3695), `RXP_WMMenuFrame`, `RXP_TalentsMenuFrame`, `RXPDangerFrame` (Tips), `RXPG_ARROW` (map.lua), `RXPItemUpgradesComparison` (ItemUpgrades). Many children use `$parent…`. Further names built at runtime: scroll bar slider `RXPV2ScrollFrame<n>ScrollBar` (UI/V2/Core.lua:1839), importer edit box `<widget type><n>Edit` (UI/V2/GuideImporter.lua:425), auction row money frame from a `moneyFrameName` argument (UI/V2/AuctionHouse.lua:53, 172; not built on Forever, B13). Children added to client frames: `$parentRXP` (QuestLog.lua:44), `$parentRXPTalents` (Talents.lua:276), `$parent_RXPLevelText` (Talents.lua:1253), `$parentBarContainer` on `RXPFrame` (Timers.lua:5). ItemUpgrades also creates a frame under the client's own naming pattern, `"AuctionFrameTab" .. index` (ItemUpgrades.lua:2195; not reached on Forever, B13).
- Frames looked up **by global name** at runtime: `_G.RXPItemFrame` (ActiveItemFrame.lua:505), `_G.RXPTargetFrame` (Targeting.lua:1358), and the bare globals `RXPTELEPORTTO` / `RXPTELEPORTHOME`, which are created only `if not RXPTELEPORTTO` / `if not RXPTELEPORTHOME` (ActiveItemFrame.lua:381-382, 393-394; inside the `addon.player.houseGUID` branch).
- Key bindings (Bindings.xml:2-14): `CLICK RXPInventory_DeleteJunk:LeftButton`, `CLICK RXPItemFrameButton1..4`, `CLICK RXPTargetFrame_FriendlyButton1..4`, `CLICK RXPTargetFrame_EnemyButton1..4`; categories `BINDING_HEADER_RXPGuides`, `…RXPTargeting`, `…RXPInventory`; literal `header` attributes "Inventory Management", "Active Items", "Active Friendly Targets", "Active Enemy Targets" (Bindings.xml:2, 3, 7, 11). Globals set: `BINDING_HEADER_RXPGuides/RXPTargeting = addon.title` (RXPGuides.lua:266-267), `BINDING_HEADER_RXPInventory` (InventoryManager.lua:88). The addon also rebinds a key itself: `SetBinding(key, DELETE_JUNK_BINDING)` (InventoryManager.lua:653-659).
- Static popups: `RXP_Link` (defined functions.lua:4828; shown at functions.lua:4802, SettingsPanel.lua:601 and :3360), `RXP_Import` (UI/V2/GuideImporter.lua:714), `RXP_CONFIRM_ORPHANED_CLEANUP_LIST` (QuestLog.lua:719-743), `RXPNoUpgradesFound` (ItemUpgrades.lua:2249), and popups registered under a caller-supplied name by `addon.comms:ConfirmChoice` (Communications.lua:708-726): `RXPTalentPrompt` (Talents.lua:676), `RXPTalentsAuditFailed`, `RXPTalentsMissingOptional` (Talents), `RXP_GUIDE_PROGRESS_PLAYER_MISMATCH` (RXPGuides.lua:1789-1790). Targeting also removes the client's own `StaticPopupDialogs["ADDON_ACTION_FORBIDDEN"]` entry (Targeting.lua:138; B18 row A2).
- Macros (account/character macro slots): `RXPTargeting`, `RXPFollow` (Targeting.lua:22-23). `RXPTargeting` is created at :190, edited at :255 and deleted at :74. `RXPFollow` is created at :284, edited at :288, :294 and :303, and deleted at :96.
- Addon-message prefixes: `RXPGComms` (Communications.lua:19), `RXPLTComms` (LevelingTracker.lua:22).
- AceEvent messages (global across all addons using AceEvent): `RXP_QUEST_ACCEPT`, `RXP_QUEST_TURNIN`, `RXP_STEP_ACTIVATED`, `RXP_STEP_DEACTIVATED`, `RXP_STEP_COMPLETE`, `RXP_OBJECTIVE_COMPLETE`, `RXP_GUIDE_LOADED`, `RXP_TARGET_LIST_UPDATE`, `RXP_FLIGHT_START`, `RXP_JUNK` (see B11), and `RXPGuidesV2_<key>` (RXPGuides.lua:2840).
- AceGUI widget type names: `RXPV2Popup`, `RXPV2GuideStepsItem`, `RXPV2GuideSteps`, `RXPV2GuideWindow`, `RXPV2ScrollFrame`, `RXPV2ActiveStepsFrame`, `RXPV2ActivePartyStepsFrame`, `RXPV2ActiveStepItem`, `RXPV2ActivePartyStepItem` (UI/V2/Core.lua:48-3169), `RXPV2AuctionHouseItemBlock`, `RXPV2AuctionHouse` (AuctionHouse.lua:204, 294), `RXPV2GuideConfigurator*` (GuideConfigurator.lua:30-1063), plus importer widget types (GuideImporter.lua:164-557).
- Virtual XML templates: `RXPV2ScrollUpButtonTemplate`, `RXPV2ScrollDownButtonTemplate`, `RXPV2ScrollBarTemplate` (UI/V2/ScrollBarTemplate.xml:3, 8, 13).

### Things a search for "RXP" would miss
- Built by concatenation: `"BINDING_NAME_" .. format("CLICK RXPItemFrameButton%d:LeftButton", i)` and the target-button equivalents (locale/enUS.lua:6-15; repeated in each locale file), `_G["BINDING_NAME_" .. DELETE_JUNK_BINDING]` (InventoryManager.lua:89), `CreateFrame("Frame", "RXP_" .. RARE_ADDON_NAME)` (CptStadicsVendorTreasures.lua:101), `"RXPTargetFrame_EnemyButton" .. index` (Targeting.lua:1174), `self.messagePrefix .. key` (RXPGuides.lua:2852).
- Names without "RXP": `RESTEDXP_BUG_REPORT_WINDOW`, `RESTEDXP_BRANDED_EXPORT` (Communications.lua:618-619, 669-670), `RESTEDXP_TRACKER_SUMMARY_WINDOW` (LevelingTracker.lua:480) — all put into `UISpecialFrames`; slash commands registered via AceConsole as `SlashCmdList["ACECONSOLE_RXP"]`, `…_RXPG`, `…_RXPGUIDES` with globals `SLASH_ACECONSOLE_RXP1` etc. (SettingsPanel.lua:310-312; AceConsole-3.0.lua:86-95).
- Names derived from the **folder name** (`addonName`, i.e. automatically renamed by a folder rename): AceAddon name (Locale.lua:5), AceLocale app (Locale.lua:9; locale/enUS.lua:4), LDB object and LibDBIcon button (SettingsPanel.lua:3705, 3725), texture paths `"Interface/AddOns/" .. addonName .. "/Textures/…"` (GuideWindow.lua:121-122, Themes.lua:17-106, 353, RXPGuides.lua:787, 822, QuestLog.lua:155, SettingsPanel.lua:3672, functions.lua:241, UI/V2/Core.lua:543), `GetAddOnMetadata(addonName, "Version"/"Title")` (RXPGuides.lua:153-154).
- Names derived from the **TOC Title** (`addon.title`): AceConfig app name and Blizzard options category (SettingsPanel.lua:3613, 3663), binding headers (RXPGuides.lua:266-267), every chat prefix (`BuildNotification`, `PrettyPrint`, Communications.lua:415-427).
- **Hard-coded folder name** `RXPGuides`: texture paths `Interface\Addons\RXPGuides\Textures\v2\scrollbar_*` (UI/V2/ScrollBarTemplate.xml:5-6, 10-11, 36); Baganator junk plugin id `"RXPGuides"` (InventoryManager.lua:1271); guide group `"RXPGuides"` special-cased (GuideWindow.lua:2535; GuideImporter.lua:581).
- Hard-coded "RestedXP" UI text (display only): `"RestedXP: " .. title` (Communications.lua:632), `L("RestedXP Feedback Form")` (:600), the Discord line (:611), "Welcome to RestedXP Guides…" (GuideWindow.lua:163, 1615; Talents.lua:302), "Welcome to RestedXP" (UI/V2/Core.lua:678), footers `"RestedXP Guides " .. release` and "RestedXP: Active Party Steps" (UI/V2/Core.lua:1392, 2461), importer title `"RestedXP %s - %s"` (UI/V2/GuideImporter.lua:274), "RestedXP Leveling Report" (LevelingTracker.lua:438), option descriptions (QuestLog.lua:561; SettingsPanel.lua:970, 1979, 2211), theme `author = "RestedXP"` (Themes.lua:22, 46, 68, 102, 332), and TOC `## Title: RestedXP Guides`, `## Title-zhCN`, `## Author: RestedXP` (RXPGuides.toc:5-6, 8).
- Hard-coded "RestedXP" text that is **functional** (it is matched against guide `#group` names, so changing either side breaks grouping): default guide groups `RestedXP Forever Guide (H/A)` (DB/forever/db.lua:35-39), which must match the `#group` line inside upstream guide files; `groupOrContent:sub(1,8) == "RestedXP"` (GuideLoader.lua:1265); the patterns `"RestedXP ([AH]…)"`, "RestedXP Speedrun Guide (A/H)", `"^RestedXP Survival…"` and `"^RestedXP Survival Guide(.*)"` (GuideLoader.lua:1329-1358); `RestedXP Forever Dungeon Guide (A/H)` (UI/V2/GuideConfigurator.lua:1573-1574, 2115-2137); `addon.GetGuideTable("RestedXP Horde 22-30", …)` (DB/forever/db.lua:670).
- **Unprefixed globals created by a missing `local`**: `ConvertID` (functions.lua:461), `parentGroup` (functions.lua:3911), `GetTableLength` (Talents.lua:65 and CptStadicsVendorTreasures.lua:594), `GetTalentData` (Talents.lua:462), `IsWorldMapAvailable`, `GetWorldMapID`, `GetMapID` (CptStadicsVendorTreasures.lua:579, 590, 592). Talents.lua and CptStadicsVendorTreasures.lua both run on Forever (Talents.lua returns only when `gameVersion > 50000`, :3; CptStadicsVendorTreasures.lua returns only when `build > 40000` or the locale is zhCN, :9). Files that begin `local addonName, addon = ...` have no local `_`, so their assignments to `_` write the global `_`: InventoryManager.lua:409, 631; RXPGuides.lua:1136; Tips.lua:170; UI/V2/GuideImporter.lua:604; functions.lua:6720 (sites read here; a `luacheck --only 111 112` run would list the rest).
- Client functions and frames that the addon hooks or replaces are listed in B18 (rows H1-H6).

---

## B6. Guide files ↔ globals (collision analysis)

How shipped guides reach the engine:
- Every leveling guide file calls the **bare global** `RXPGuides.RegisterGuide([[ … ]])` (720 calls across the
  camelot-loaded guide files, including translations; e.g. Guides/forever/Horde-01-12_Durotar.lua:5).
- English guide files also read the bare global `RXP`: `local L = GetLocale() if L and RXP.enabledLocale[L] then return end`
  (36 occurrences; e.g. Guides/forever/Horde-01-12_Durotar.lua:4). `RXP` is `addon` (RXPGuides.lua:2771).
- Translated files check `GetLocale()` only (e.g. lang/Guides-deDE/forever/Horde-01-12_Durotar.lua:1).
- Talent guides use the private namespace `addon.talents.RegisterGuide` (Guides/Talents/classic-warrior.lua:5), so they
  have no global coupling.
- No shipped guide uses `ImportGuide`.

Binding mechanism: `RXPGuides.lua:225` sets `_G.RXPGuides` to a fresh table unconditionally; GuideLoader.lua:1389-1394
fills `RegisterGuide/ImportGuide` only `if not` already set (on a fresh table they are not). `RXP = addon` is set near
the end of RXPGuides.lua (:2771), and RXPGuides.lua precedes every guide list in the TOC (B1 steps 4 and 8), so
both globals exist before the first guide file runs. Inferred: if the client runs one addon's files to completion before
the next addon (a premise that is not in source; B17 item 8), each addon's guide files bind to whichever `RXPGuides`/`RXP`
table exists while that addon loads — so at **load time** a renamed addon that still exports `_G.RXPGuides` and `_G.RXP`
before its guide lists would register its own guides correctly.

What collides if both addons are loaded (renamed folder, unmodified guide files):

| Shared name | Effect (inferred unless cited) |
|---|---|
| `_G.RXPGuides`, `_G.RXP` | last-loaded addon wins after load. Engine code calls the **global** `RXP` at runtime: GuideWindow.lua:89 (`addon.NextStep` → `RXP.SetStep`), map.lua:1239 (`RXP.UpdateMap`), QuestLog.lua:86 and DB/questDB.lua:793, 820 (`RXP.CalculateTotalXP`), functions.lua:6936 (`RXP.GetMapId`). With both loaded these reach the other addon. Six engine edits (`RXP.` → `addon.`) remove this |
| `_G.RXPGuides.talents` | overwritten (Talents.lua:1415) |
| AceGUI widget types `RXPV2*` | AceGUI ignores a registration whose version is not higher than the one already registered (AceGUI-3.0.lua:549-558). With equal versions the second addon's constructors are ignored, so its windows are built by the other addon's closures. Registering the same names with higher version numbers would instead replace the other addon's constructors, so only renaming the types separates the two addons |
| XML virtual templates `RXPV2Scroll*` | duplicate global template names; the textures point into the `RXPGuides` folder. What the client does with a duplicate template name is not confirmed from source (B17 item 7) |
| Named frames (B5), `_G.RXPItemFrame`/`_G.RXPTargetFrame` lookups, `CLICK RXP…` bindings | Inferred: a second `CreateFrame` with the same name replaces the global reference, so bindings and lookups reach one addon only. Not confirmed from source: nothing in the engine or bundled libraries defines what `CreateFrame` does with a name already in use; loading both addons in the client would settle it (B17 item 7) |
| `RXPTELEPORTTO`, `RXPTELEPORTHOME` secure buttons | certain from source: each is created only when the bare global is nil (ActiveItemFrame.lua:381-382, 393-394), so the addon that runs this second never creates its own buttons and uses the first addon's |
| `_G.RXPV2GuideWindow` (UI/V2/Core.lua:1480); `RESTEDXP_BUG_REPORT_WINDOW`, `RESTEDXP_BRANDED_EXPORT`, `RESTEDXP_TRACKER_SUMMARY_WINDOW` in `UISpecialFrames` (B5) | plain global assignments and shared names: last writer wins |
| Leaked helper globals `ConvertID`, `parentGroup`, `GetTableLength`, `GetTalentData`, `IsWorldMapAvailable`, `GetWorldMapID`, `GetMapID` (B5) | last-loaded addon's functions replace the other's; the same names would also collide with any third addon that uses them |
| `ChatFrame_DisplayTimePlayed`, `ChatFrameUtil.DisplayTimePlayed` | each addon wraps whatever is there at its own load (LevelingTracker.lua:29, 37, 46-48), so with both loaded the client function is wrapped twice |
| `UIParent:UnregisterEvent("ADDON_ACTION_FORBIDDEN")` (Targeting.lua:150) | when either addon runs this, the client's default forbidden-action popup handler is unregistered for every addon (B18 row A2) |
| Baganator junk plugin id `"RXPGuides"` (InventoryManager.lua:1271) | both addons register a plugin with the same id; Baganator's handling of a duplicate id is not in this checkout |
| AceConfig application name and Blizzard options category (both `addon.title`, i.e. the TOC Title) | **hard error, not "last writer wins"**: with an unchanged Title the second addon's `AceConfigDialog:AddToBlizOptions(addon.title)` (SettingsPanel.lua:3663) reaches `error("%s has already been added to the Blizzard Options Window with the given name: %s")` (libs/mainline/AceConfig-3.0/AceConfigDialog-3.0/AceConfigDialog-3.0.lua:2022-2023) inside `CreateAceOptionsPanel`. This presumes both addons receive the same AceConfigDialog instance through the single global LibStub (LibStub.lua:3-4) |
| Macros `RXPTargeting`, `RXPFollow` | both addons create, edit and delete the same macros |
| AceEvent messages `RXP_*`, `RXPGuidesV2_*` | each addon receives the other's step/guide/active-step messages (e.g. listener SettingsPanel.lua:4148; v2 handlers RXPGuides.lua:2861-2895) |
| Comm prefixes `RXPGComms`, `RXPLTComms` | messages interoperate; `rxpGroupDetected` would fire for RestedXP party members |
| Static popups, `SLASH_ACECONSOLE_RXP*`, `BINDING_HEADER_*` | last writer wins: popups and binding headers are plain assignments, and AceConsole overwrites `SlashCmdList[name]` (AceConsole-3.0.lua:86-95) |
| `_G.RXPGuides_Themes` | first addon to initialise consumes and wipes it (Themes.lua:320-325) |
| SavedVariables names | Inferred: two addons declaring the same SavedVariables name would share or overwrite one global — hence the rebrand map. Not confirmed from source: AceDB only reads `_G[name]`, and how the client loads and saves two addons' same-named variables is not in this checkout; it needs the client (B17 item 7) |

No mechanism exists in the engine to pick a different global name for guide registration; the only indirection is that
`GuideLoader.lua` itself uses a **local** alias (`local RXPGuides = addon.RXPGuides`, GuideLoader.lua:17) so its own
call `RXPGuides.ImportGuide` (:1634) is not affected. Keeping upstream guide files unmodified therefore requires our
addon to export `_G.RXPGuides` and `_G.RXP` during its own load (and accept that RestedXP, if loaded later, replaces
them), or to set them just before our guide lists and restore them after (an engine/TOC design decision — Don's call).

---

## B7. Guide import and encryption

### Entry points (UI → importer)
- `/rxp import` (SettingsPanel.lua:107-108).
- Options button "Import Guides" (SettingsPanel.lua:605-616).
- Guide window menu "Import guide" (GuideWindow.lua:2715-2721).
- V2 configurator import button (UI/V2/GuideConfigurator.lua:1105) and "Import Guides" card (:1776-1781).
- Deferred after combat when `settingsPanelAfterCombat == "Import"` (RXPGuides.lua:1882-1883; set at GuideLoader.lua:1421).
- **Automatic at login** from `RXPString` (GuideLoader.lua:814-877, called from `addon.LoadCachedGuides`, RXPGuides.lua:1601); this path also calls `Open()` (GuideLoader.lua:863).
- Every user-interface path goes through `addon.guideImporter:Open()` (GuideLoader.lua:1419-1433) → builds UI via `addon.ui.v2:InitializeGuideImporter/CreateGuideImporter` (UI/V2/GuideImporter.lua:15, 850-1129). The complete list of `Open()` callers is SettingsPanel.lua:108, 613; GuideWindow.lua:2719; UI/V2/GuideConfigurator.lua:1105, 1780; RXPGuides.lua:1883; GuideLoader.lua:863; and the paste popup's re-open paths UI/V2/GuideImporter.lua:730, 742, 748.
- **Entry points that bypass `Open()` and the user interface**: the public globals `_G.RXPGuides.ImportGuide` and `_G.RXPGuides.RegisterGuide` (GuideLoader.lua:1389-1394) can be called by any other addon or a `/run` command. `addon.ImportGuide` (GuideLoader.lua:499-520) parses the text, adds the guide, marks it `imported = true` and caches it in `RXPDB.profile.guides` through `CacheGuide`, which itself calls `ReadCacheData("string")` and therefore `BNGetInfo` (:489). The login loader of cached guides (step 8 below) also runs without `Open()`.
- **A second paste-a-string import, unrelated to guides**: the level-splits menu entry "Import" opens `addon.comms.OpenBrandedExport(…, addon.tracker.ImportSplits)` (LevelingTracker.lua:927-932). `ImportSplits` (LevelingTracker.lua:1383-1403) runs `LibDeflate:DecodeForPrint` → `DecompressDeflate` → AceSerializer `Deserialize` and stores the table in `addon.db.profile.reports.splits[reportKey]` (`RXPDB`). The matching export is `BuildSplitsExport` (:1377-1381). It carries data only, is not bound to an account and executes no code.

### The pipeline
1. Paste: edit box buffers input (UI/V2/GuideImporter.lua:405-470; `ProcessBuffer` :766); long strings can be pasted in
   pieces via popup `RXP_Import` (:709-764).
2. `guideImporter:Validate` (:679-707) → `ProcessImportBox` (:560-573) → `guideImporter:ImportString(str)` (GuideLoader.lua:1533-1601).
3. `ImportString` parses header `<nGuides>|<hash>:…|<base>` (:1544-1558), rejects `base < addon.version` (:1560-1568),
   temporarily forces CVar `scriptErrors=1` (:1540-1542, restored :1527-1531), then `LoadImportBuffer` (:1440-1467)
   splits chunks `(%-?%d+)(%D)([base64]+)%` and calls `CheckDataIntegrity` per chunk.
4. `CheckDataIntegrity` (GuideLoader.lua:380-464): mode byte must be 58 (`:`) (:382); key schedule from
   `ReadCacheData("buffer")` (:387-395); base64 decode via `C_EncodingUtil.DecodeBase64` or `addon.read` (plc/base64) (:397-405);
   byte-wise stream cipher (:411-426) — inferred RC4-style from the swap/xor structure (the algorithm is not named in
   source, so the identification is not confirmed from source; comparing the loop with a reference RC4 would settle it); checks zlib header and Adler-32
   trailer against the chunk hash, else **"Account mismatch, import string does not apply to current account"** (:438-442, 461-463);
   decompress with `C_EncodingUtil.DecompressString` or `LibDeflate:DecompressZlib` (:446-455).
5. Key derivation `addon.ReadCacheData` (GuideLoader.lua:590-646): calls `_G[DeserializeTable(addon.base)]()` and takes the
   2nd return (:592). `addon.base = {66,78,71,101,116,73,110,102,111}` (DB/shared.lua:37) spells **`BNGetInfo`**, whose
   2nd return is the BattleTag (inferred from the API, not confirmed from source: the code only takes `select(2, …)`,
   lowercases it and keeps the last 16 characters, and never names the value; reading the return in the client would
   settle it, B17 item 3). The lowercased last 16 characters are mixed into a 16-byte key (:596-617) and stored in
   `RXPData.cache` (:618); `cachedData.string` = Adler-32 of the key minus `floor(addon.version/100)` (:625-629);
   `"buffer"` mode runs a 256-byte key schedule (:631-643). So imported strings are **bound to the Battle.net account**.
   The importer UI makes the same call in `CheckBattleNet` (UI/V2/GuideImporter.lua:599-607, debug text "Battle.net not
   cached, querying"), which runs on every importer UI update (:798) and, when `RXPData.cache` is empty, stores the **raw
   second return** in the account SavedVariable `RXPData.cache` (:604) rather than the mixed key table. Opening the importer
   on an account with no cached value can therefore write the raw value to disk; `ReadCacheData` later reuses whatever is
   stored when the call returns nothing (GuideLoader.lua:593-594).
   Three call sites reach `BNGetInfo`: GuideLoader.lua:592 and UI/V2/GuideImporter.lua:604 (both through `addon.base`), and
   Communications.lua:592, which calls the bare global directly for the bug-report form's "Online/Offline" field.
6. `ProcessInputBuffer` (GuideLoader.lua:1603-1711) feeds each decrypted guide to `RXPGuides.ImportGuide` (local alias)
   → `addon.ImportGuide` (:499-520) → `ParseGuide` + `AddGuide`, then `addon.CacheGuide` (:477-496).
7. Caching: `CacheGuide` minifies, prefixes `"--" .. ReadCacheData("string")`, deflates (`CompressDeflate`, :466-474) and
   stores into `RXPDB.profile.guides[key|n]` (:489-494). Header (`guideContent/guideLength/guideId`) saved at :1671-1680.
8. Re-validation at every login (`LoadCachedGuides`, GuideLoader.lua:880-944): metadata reused only if
   `metadata.length == ReadCacheData("string")` (:893-894); otherwise decompress and require the `--<account string>`
   prefix (:926-927); failures are deleted (:939-942). Metadata dropped when the addon release changes (:889-891).
9. UI state tied to Battle.net: import button disabled without `RXPData.cache` (UI/V2/GuideImporter.lua:810);
   message "Battle.net unreachable…" (:1123-1126); "Please restart your game client" (:570).
10. Guide text can reach `loadstring`. The guide header command `#setquestdb` runs
    `assert(loadstring("return " .. str))` and then `setfenv(t, {})` before calling the chunk (DB/questDB.lua:1150-1158), at
    parse time, when the guide's group has no quest database yet (:1152-1155). The empty environment means the chunk can
    reference no globals. This is the only `loadstring`/`setfenv` in engine code (text search), and it is reachable from
    any guide text, including an imported string or a call to the global `RXPGuides.RegisterGuide`. No guide file loaded
    on Forever uses `#setquestdb` (text search of `Guides/forever`, `Guides/SurvivalGuide`, `Guides/Classic-Attunements.lua`
    and `Guides/Classic-0.5.lua`).

### "Paid/premium" markers
No code string says "paid", "premium" or "purchase". The distinction is structural: imported guides are flagged
`imported = true` (GuideLoader.lua:507, 914, 937) and are listed/deletable in the importer
(UI/V2/GuideImporter.lua:575-597). Inferred: the account-bound import path is how non-public guides are delivered. This
is plausible but cannot be proved from source: nothing in the checkout says who issues import strings or on what terms.

### Minimal disable set for P1 (inferred)
1. Make `addon.guideImporter:Open` a no-op and remove the 5 UI entry points listed above (SettingsPanel.lua:107-108, 605-616; GuideWindow.lua:2715-2721; GuideConfigurator.lua:1105, 1776-1781). This alone leaves the global `RXPGuides.ImportGuide` (GuideLoader.lua:1393-1394) and the login cache loader alive; they are covered by steps 2 and 4.
2. In `LoadCachedGuides`, skip the `RXPString` block (GuideLoader.lua:814-878) and the `addon.db.profile.guides` loop (:880-944); drop `RXPString` from the TOC.
3. Remove or stub **all three** `BNGetInfo` call sites: GuideLoader.lua:592 and UI/V2/GuideImporter.lua:604 (through `addon.base`, DB/shared.lua:37) and the direct call at Communications.lua:592. Removing the `addon.base` table alone does not disable the path: `addon.DeserializeTable(addon.base)` iterates its argument with `pairs` (GuideLoader.lua:370-376), so a nil `addon.base` raises an error at GuideLoader.lua:592 and UI/V2/GuideImporter.lua:604. `ReadCacheData` is reached only from CheckDataIntegrity (:387), CacheGuide (:489) and LoadCachedGuides (:894, :927).
4. Do not load `UI/V2/GuideImporter.lua` (manifest.xml:6) once nothing calls it, and stop exporting `_G.RXPGuides.ImportGuide` (GuideLoader.lua:1393-1394). `addon.ImportGuide` is still referenced by `LoadGuide` for `cache = true` queue entries (GuideLoader.lua:648-651, 512-518); those entries are created only by `ImportGuide` itself, so the chain dies with it.
5. `LibDeflate` has other users and cannot be dropped with the importer: the level-splits export and import (LevelingTracker.lua:11, 1380-1390) and the encoding of the `STEP` party payload (GuideWindow.lua:8, 3169, 3215-3218). Its importer uses are GuideLoader.lua:16, 454, 473, 900-926.
6. The `#setquestdb` `loadstring` path (pipeline step 10) and the level-splits string import are separate from the account-bound importer and are not removed by steps 1-5.

---

## B8. Commercial and outbound elements

| Location | Element |
|---|---|
| SettingsPanel.lua:594-604 | "Join Discord" button → shows `https://discord.gg/restedxp` in copy popup `RXP_Link` |
| Communications.lua:611 | Feedback form label "Join our support discord at discord.gg/RestedXP … #bug-report" (translations in locale/{deDE:52, esES:48, frFR:50, koKR:52-53, zhCN:49, zhTW:48}.lua) |
| Communications.lua:600, 632 | "RestedXP Feedback Form", "RestedXP: " window titles |
| Communications.lua:464-622 | bug-report form: builds text with race/class/level, zone and coordinates, guide, addon version, XP rate, locale, client build, **BNet online/offline** (:592), step data, arrow data, addon errors — displayed locally for copy/paste; not transmitted |
| SettingsPanel.lua:605-616 | "Import Guides" button (import path, B7) |
| functions.lua:4801-4840 | `.link` DSL shows any URL in `RXP_Link`; camelot-loaded guides contain YouTube and wow-petopia links (e.g. Guides/forever/Alliance-1-10_NightElf.lua:353, 2032) |
| readme.md | link to restedxp.com "create-your-own-restedxp-guide" (not loaded in game) |
| CptStadicsVendorTreasures.lua:3, 5 | curseforge URL and CC BY-NC 3.0 URL in header comment |
| ItemUpgrades.lua:881; Talents.lua:1292 | wowhead URLs in comments |
| Themes.lua:312; SettingsPanel.lua:4056, 4063; locale/zhTW.lua:7 | wowinterface, wowwiki-archive and github URLs in comments |
| RXPGuides.toc:24-25 (and the TBC and Vanilla TOCs) | `## X-Curse-Project-ID: 486246`, `## X-Wago-ID: ZKbebq61` — identifiers that tie a built package to RestedXP's CurseForge and Wago listings (B16) |
| RXPGuides.toc:5-6, 8 | `## Title: RestedXP Guides`, `## Title-zhCN`, `## Author: RestedXP`; the Title becomes `addon.title`, the prefix of every chat line and announcement (B5, B9) |

Search terms `restedxp.com`, `shop`, `purchase` (other than vendor-buy code functions.lua:5670-5672), `premium`,
`patreon`, `subscribe` found nothing else in engine or locale code. A URL search over engine and locale code finds only
the hosts in the table above. In the guide files loaded on Forever (English plus the five translated sets) the only link
hosts are www.youtube.com (498 links), youtu.be (192) and www.wow-petopia.com (28); some YouTube links carry
`ab_channel=RestedXP`.

No telemetry was found. Within source, the data that leaves the machine is addon messages, chat messages, emotes and quest
sharing (all in B9); the bug form is copy-only. That the client offers addons no other network path is a statement about
the client, not something this checkout shows (CLAUDE.md records it as a platform fact).

---

## B9. Communications

`addon.comms` = AceAddon module with AceEvent, AceComm, AceSerializer (Communications.lua:17). `Setup` (:38-69) runs
from `OnInitialize` (RXPGuides.lua:1591), creates `RXPCComms`, registers events (XP/level events only below max level
:45-49; group events always :52-56) and `RegisterComm("RXPGComms")` (:58).

### Addon messages (invisible to players)

| Message | Channel | When | Gate |
|---|---|---|---|
| `ANNOUNCE`/`REPLY` `{player={name,class,level,xpPercentage}, addon={release}, guide={name,version}}` (:236-252) | PARTY (:338-343) | login/reload (:94-101), group formed after 6-10 s (`5 + math.random(5)`, :5, :103-110), reply on receipt (:265-267) | **none** beyond "in group > 1 and not in battleground" (:339) |
| `STEP {encodedPayload}` (active steps) | PARTY, priority ALERT (:815-824) | step changes, group events (:141-145, :123) | `enableBetaFeatures` and `shareActiveSteps` (:810-813) |
| `LEVEL_REPORT_REQ` / `LEVEL_REPORT_RESP` (prefix `RXPLTComms`) | WHISPER to inspected player (LevelingTracker.lua:1429, 1467) | on Inspect of a friendly target | `enableLevelingReportInspections` (default true, SettingsPanel.lua:135) and `enableBetaFeatures` (not in the defaults table, so off). Both are tested at LevelingTracker.lua:112; the `INSPECT_READY` handler tests only the first (:1449), but the event, the comm prefix and the `NotifyInspect` hook (:121) are registered only inside the :112 block (:117-121), so both settings gate it |

Received: `OnCommReceived` (:254-275) records the sender as an RXP user, prints "There's a new addon version"/"new
version … for <guide>" when `checkVersions` (default true, SettingsPanel.lua:134) (:319-335), forwards `STEP` to
`addon.v2.events` (:271-272).

`LEVEL_REPORT_REQ` is answered for **any** whisper sender on the `RXPLTComms` prefix: the handler checks only the prefix,
the WHISPER distribution and that the player is not in a battleground, then replies with the full `CompileData()` report,
the player's name and level and time played this level (LevelingTracker.lua:1405-1429). It does not check that the sender
inspected the player or is friendly.

### Chat messages sent on the player's behalf (visible)

| Function | Channel | Content | Gate (default) |
|---|---|---|---|
| `announceLevelUp` (:26-36) | PARTY / EMOTE / GUILD | "{rt3} RestedXP Guides: I just leveled up to Y" when the tracker is off (:148-149); "{rt3} RestedXP Guides: I just leveled from X to Y in T" when it is on (:166, 179). The prefix is `addon.title` (:415) | `enableLevelUpAnnounceGroup` (false), `…Solo` (false), `…Guild` (not in defaults → off) (SettingsPanel.lua:130-131) |
| `AnnounceStepEvent '.complete'` (:362-378) | PARTY | "Completed <objective>" | `enableCompleteStepAnnouncements` (not in defaults → off); also needs `alwaysSendBranded` (default **true**, SettingsPanel.lua:133) or a detected RXP party (:347); suppressed if Questie loaded unless `ignoreQuestieConflicts` (:364) |
| `'.collect'` (:380-395) | PARTY | "Collected <item>" | `enableCollectStepAnnouncements` (off), same extra gates |
| `'.fly'` (:397-409) | PARTY | "Flying to <dest> ETA <time>" | `enableFlyStepAnnouncements` (default **true**, SettingsPanel.lua:132) + `alwaysSendBranded` |
| `PrettyAnnounce` (:423-427) | any | branded text | no callers found in engine |
| `grouping:ShareQuest` (:739-759) | quest push | `QuestLogPushQuest` | `shareQuests` (default false) |
| `.emote` guide command (functions.lua:6254-6287) | emote, visible to nearby players | `DoEmote(token)` when the step is active and the targeted NPC id matches, or when the step's callback returns true (:6279-6285) | no settings toggle; triggered by guide text, including imported guides. No guide file loaded on Forever uses `.emote` (text search of the English guide set) |

All announcements are skipped inside instances (:349). The "Enable Group Settings" toggle, when switched on, sets
`checkVersions`, `alwaysSendBranded`, `showUnusedGuides`, `shareQuests`, `shareActiveSteps`, the level-up group
announcement, all three step announcements, `enableQuestAutomation`, `autoSellJunk`, `autoDiscardItems`,
`enableGroupQuests`, `createFollowMacro` and `enableNonLeadMarking` to true and `soloSelfFound` to false in one click
(SettingsPanel.lua:802-840). DB/questDB.lua:1752-1820 (`addon.CompleteStep`) whispers GM dot-commands to the player
self; it returns early when `C_SettingsUtil` exists unless on build 70532 (:1753-1756).

Other side channels: `SendEvent` forwards every `RXP_*` message to `WeakAuras.ScanEvents` / `ForeverAuras.ScanEvents`
(RXPGuides.lua:122-128). LevelingTracker replaces `ChatFrame_DisplayTimePlayed` and `ChatFrameUtil.DisplayTimePlayed`
globally to hide `/played` output (LevelingTracker.lua:27-54).

---

## B10. Settings system

- Declared as one AceConfig options table built inside `addon.settings:CreateAceOptionsPanel()` (SettingsPanel.lua:563-3676),
  `childGroups = "tab"` (:592), with top-level groups `generalSettings` (:654), `guideRoutingSettings` (:1193), `targeting` (:1625),
  `levelTrackerFeatures` (:1959), `communications` (:2135), `tipsPanel` (:2287), `helpPanel` (:2667), `lookAndFeel` (:2673),
  `advancedSettings` (:3310), plus AceDBOptions `profiles` (:3615-3661) and buttons discord/import/feedback/configurator/reset (:594-653).
  Generic getter/setter read/write `addon.settings.profile[key]` (:531-535).
- Defaults: local `settingsDBDefaults` (SettingsPanel.lua:127-258), not exported.
- Registration: `AceConfig:RegisterOptionsTable(addon.title, optionsTable)` (:3613), `addon.RXPOptions = AceConfigDialog:AddToBlizOptions(addon.title)` (:3663); logo from `Textures/rxp_logo-64` (:3669-3674). Opening: `addon.settings.OpenSettings` via `Settings.OpenToCategory` (:61-89); deferred in combat (:63-67, RXPGuides.lua:1877-1886).
- Slash: `/rxp`, `/rxpg`, `/rxpguides` → `ChatCommand` (:103-125, :310-312) with `import`, `debug`, `splits`, `show|hide|toggle`, `bug|feedback`, `preview`, `help`.
- Module toggle wiring is ad hoc per feature: e.g. `enableTips` setter re-runs `itemUpgrades:Setup` (:2292-2303); `enableTracker`, `enableTalentGuides` force `ReloadUI` (:1964-1974, :1127-1143); `enableInventoryManager` calls `inventoryManager:Setup` (:986-996); `enableVendorTreasure` is read only at Setup (:778-786, CptStadicsVendorTreasures.lua:613). Visibility of options depends on the module object existing (`hidden = not addon.itemUpgrades`, :2543-2545).
- **Cleanest route for a new module (inferred):** the main table is a closure local and has no extension API, so a new
  file should register **its own** AceConfig table and attach it as a sub-category with
  `AceConfigDialog:AddToBlizOptions(appName, name, addon.title)` — the parent parameter is supported in the bundled
  mainline AceConfigDialog (AceConfigDialog-3.0.lua:1983, 2013-2020). The parent is looked up through
  `BlizOptionsIDMap[parent]` and a missing parent raises "The parent category '%s' was not found" (:2014-2018), so this
  call works only **after** the main panel has been registered at SettingsPanel.lua:3663. Store the toggle either in
  `addon.settings.profile` (shares profiles/defaults copy) or in the module's own SavedVariable; create frames and
  register events only in the enable path, and in the disable path call `UnregisterAllEvents` and hide/release frames.
  InventoryManager is close to this pattern but is not an example of "off creates nothing": its `Setup` calls
  `self:SetupUI()` and `self.bagManager:Setup()` before the feature gate (InventoryManager.lua:58-61), and the disabled
  branch still registers `ADDON_LOADED` (:62-63) while hiding its frames (:66-70). `bagManager:Setup` was not read. The
  settings page itself is the only frame that must exist while off.
- CVars the engine writes (they persist outside the addon unless noted): `questPOI` on first ever login
  (RXPGuides.lua:1500-1504); five outline/graphics CVars when `lootSparkle` is on, Forever only (RXPGuides.lua:1545-1553;
  toggle SettingsPanel.lua:842-874; `lootSparkle` is not in the defaults table); `nameplateMaxDistance` set to "41" below
  interface 40000 or "100" above, when `enableTargetAutomation` and `enableMaxNameplateDistance` are on — both default
  true (Targeting.lua:99-113; SettingsPanel.lua:176-177); `scriptErrors` during an import (GuideLoader.lua:1528, 1542) and
  from an advanced option (SettingsPanel.lua:3384); `maxfps` during hearthstone batching (HSBatching.lua:27, 38, 64;
  `enableHSbatch` is not in the defaults table); `previewTalents`, only when `addon.game == "WOTLK"` (Talents.lua:207-211),
  so never on Forever.
- First-run / onboarding: the V2 **Guide Configurator** opens on every `PLAYER_ENTERING_WORLD` call path
  (RXPGuides.lua:1831) but only shows for a level-1 character with no saved or loaded guide (UI/V2/GuideConfigurator.lua:1533-1547).
  Also on first ever login `SetCVar("questPOI","1")` (RXPGuides.lua:1500-1504), and at level 1 a "progress saved by another
  character — reset?" prompt (:1777-1794).

---

## B11. Module mechanism and hook points

### AceAddon and modules
- `addon = LibStub("AceAddon-3.0"):NewAddon(addon, addonName, "AceEvent-3.0")` (Locale.lua:5) — the private
  namespace table becomes the AceAddon object named after the folder.
- Modules via `addon:NewModule`: Communications (Communications.lua:17), Settings (SettingsPanel.lua:41), VendorTreasures
  (CptStadicsVendorTreasures.lua:22), GuideImporter (GuideLoader.lua:1398), InventoryManager (InventoryManager.lua:33),
  ItemUpgrades and ItemUpgradesAH (ItemUpgrades.lua:25, 1531), LevelingTracker (LevelingTracker.lua:16), Talents
  (Talents.lua:20), Targeting (Targeting.lua:21), Tips (Tips.lua:21), GuideConfigurator and V2Events (RXPGuides.lua:2819, 2839).
- **None of these define `OnInitialize`/`OnEnable`**; only the main addon does (RXPGuides.lua:1491, 1656). Modules are
  started by explicit `Setup()` calls:

| Module | Started at | Own gate |
|---|---|---|
| Settings | `InitializeDatabase` :1539, `InitializeSettings` :1543 | — |
| Communications | `comms:Setup()` RXPGuides.lua:1591 | none |
| Targeting | :1592 and every PEW :1833 | `enableTargetMacro`, `enableTargetAutomation` etc. (Targeting.lua:73-120); the proximity scan additionally needs `showTargetingOnProximity` and `addon.unitscanEnabled` (Targeting.lua:115-151, 542; B18 rows A1-A2) |
| Talents | :1593 `if addon.talents` | `enableTalentGuides` + `IsSupported()` (Talents.lua:197-201) |
| LevelingTracker | :1594-1596 | `enableTracker` |
| Tips | :1597 | `enableTips` (Tips.lua:36). When on, `Setup` hooks `WorldFrame` `OnUpdate` (Tips.lua:52); nothing in source removes the hook when the setting is switched off, and `CheckEvents` re-tests `enableTips` on every call (:92) |
| InventoryManager | OnEnable :1662 | `IsFeatureEnabled()` (InventoryManager.lua:61) |
| VendorTreasures, ItemUpgrades | OnEnable + 0.2 s (:1772-1775) | `enableVendorTreasure` (default true, SettingsPanel.lua:199); `enableItemUpgrades` + `enableTips`. VendorTreasures also hooks `WorldMapFrame.OnMapChanged` at file load, before any setting is read (CptStadicsVendorTreasures.lua:610); the hooked function tests the setting (:600-604). ItemUpgrades does not exist on Forever (B13) |
| GuideConfigurator / V2Events | `addon.v2:Setup()` :1612 → RXPGuides.lua:2821-2823 | `IsSupportedClient()` |
| ActiveItemFrame | `addon:CreateActiveItemFrame()` :1590 (not a module) | `disableItemWindow` |
| HSBatching | file-level frame; at file load, regardless of any setting, it registers `UNIT_SPELLCAST_INTERRUPTED` (HSBatching.lua:71-81) and installs `hooksecurefunc` hooks on `UseContainerItem` (`C_Container` method at :85 or the global at :89), `UseItemByName` (:96 or :100), `CastSpellByName` (:106), `CastSpellByID` (:111), `UseAction` (:115) and the `CONFIRM_BINDER` popup's `OnCancel`/`OnAccept` (:122-134). The `SetCVar` hook at :44 is inside a block comment (:43-52) and is not installed | `enableHSbatch` (not in the defaults table, so off) is checked only when a hooked call starts the timer (:55); when on, an `OnUpdate` script calls `ConfirmBinder()` (:33-36, :60) and `maxfps` is changed (:27, :38, :64) |
| Timers | file-level `BarContainer` on `RXPFrame` (Timers.lua:5-16) | `showFlightTimers` |

- A new file listed in our TOC receives the same `addon` via `...` and can call `addon:NewModule(...)`. AceAddon queues it
  (AceAddon-3.0.lua:136-137, 231-242) and calls its `OnInitialize` after the main addon's (FIFO, :613-620) and `OnEnable` at
  PLAYER_LOGIN (:623-628) — usable without engine edits.

### Hook points available to new files

| Hook | Payload | Source |
|---|---|---|
| `addon:RegisterMessage("RXP_STEP_ACTIVATED", fn)` | step, guide | GuideWindow.lua:804 (wrapper allows many callbacks per message, RXPGuides.lua:86-92). The wrapper calls `func(message, …)` (:80-84), so the callback must be a function — AceEvent's method-name strings do not work. `addon:UnregisterMessage(message)` without a callback argument wipes **every** callback for that message, the engine's included (:94-102); pass the callback to remove only one |
| `RXP_STEP_DEACTIVATED` | step, guide | GuideWindow.lua:927 |
| `RXP_STEP_COMPLETE` (queued) | step, guide | GuideWindow.lua:736 |
| `RXP_OBJECTIVE_COMPLETE` (queued) | element, guide | functions.lua:985 |
| `RXP_GUIDE_LOADED` (queued) | guide | GuideWindow.lua:2155 |
| `RXP_QUEST_ACCEPT` | questId | RXPGuides.lua:305 |
| `RXP_QUEST_TURNIN` | questId, numChoices, chosen index | RXPGuides.lua:969, 982, 1027, 1031 |
| `RXP_TARGET_LIST_UPDATE` (queued) | unitscan, mobs, targets | GuideWindow.lua:977, 1228 |
| `RXP_FLIGHT_START` | currentFP, dest, timer | Timers.lua:229 |
| `RXP_JUNK` | id, bag, slot | InventoryManager.lua:459, 870 |
| `addon.v2.events` messages `RXPGuidesV2_UpdateActiveSteps/QuestDataLoaded/GuideStepsChanged/GuideWindowRefresh` | various | RXPGuides.lua:2839-2858 |
| `addon.functions.<name>` custom DSL commands | — | Part A |
| `addon.stepLogic.*` guide/step filters | — | RXPGuides.lua:2492-2769 (replaceable table functions) |
| `_G.RXPOnInitialize` | — | RXPGuides.lua:1573-1575 (global, debug) |
| `addon.enabledFrames[name] = frame` (+ optional `frame.IsFeatureEnabled`) joins the global show/hide toggle | — | GuideWindow.lua:26, ActiveItemFrame.lua:274-276, SettingsPanel.lua:3736-3746 |

Queued messages are flushed by `ProcessMessageQueue` from the update loop (RXPGuides.lua:135-150, 2420). Caveat: these are
global AceEvent messages, so with RestedXP also loaded our listeners also receive RestedXP's messages (B6).

Where **no** hook exists: guide-loaded-from-cache, step-skipped, waypoint-reached, settings-panel extension, minimap menu
extension (`buildMinimapMenu` is local, SettingsPanel.lua:3678-3689), talent-guide registry for non-CLASSIC games, and
item scoring (ItemUpgrades is not instantiated on Forever). Each needs an engine edit or a parallel implementation.

---

## B12. Bundled data on Forever

No file in `DB/forever/`, `DB/shared.lua` or `DB/questDB.lua` has a header naming its data source. None mentions Questie
data, cMaNGOS/MaNGOS or wowhead (searched case-insensitively). DB/questDB.lua and functions.lua only call Questie at
runtime (B14).

| File | Lines / bytes | Contents and shape | Notes |
|---|---|---|---|
| DB/shared.lua | 50 / 946 | `mapConversion={}`, `skipPreReq[questId]=1`, `repStandingID`, `repStartValue`, **`addon.base` = bytes of "BNGetInfo"** (:37), `GetSubZones`, `GuideNames` | loads for every flavour that includes it |
| DB/forever/flightData.lua | 1012 / 25611 | `addon.FPDB[faction][nodeId] = { name=…, [destNodeId]=seconds }` (inferred unit) | includes Riverglades nodes ("Rog'mar, Riverglades" :25; "Farhold Keep, Riverglades" :661). Upstream commit subject "Added forever FP data" (docs/UPSTREAM.md:12) |
| DB/forever/quest.lua | 231 / 11901 | `skipPreReq`, `questConversion={}`, `questCompleteItems[questId]=itemId -- Quest // Item` (:19ff), `questTurnInItems`, `questAcceptItems` | |
| DB/forever/spells.lua | 1630 / 41717 | `HCSpellList` (spell IDs), `defaultSpellList[race|class][level] = {spellIds}` (:18-45; shape per RXPGuides.lua:598-603) | comment "regular classic era spell list" (:2); `diff` against DB/classic/spells.lua prints 499 lines |
| DB/forever/rares.lua | 1661 / 89267 | `addon.rares` (per locale) | **never active on Forever**: returns when `gameVersion >= 11508` (:7-10) |
| DB/forever/db.lua | 1729 / 55141 | `skipPreReq`, `defaultGroup` (:34-40), `mapId` name→UiMapID (:46ff, e.g. Durotar 1411), `ignoredMaps`, `mapIdToName`, `dungeonList` abbreviations→id incl. `KS=17780` Krol'dok, `AP=2079` Alcaz, `BH=1216` Blackmaw, `TST=16985` Shaper's Terrace (:148-151), `FPbyZone`, `professionID`, profession guides, `functions.xpto60*`/`xpcheck` (:327-675), `mountIDs` | defaultGuideList is commented out (:19-31) |
| DB/forever/dangerousMobs.lua | 7281 / 320058 | `dangerousMobs[faction][zone][mobName] = { {MinLevel, MaxLevel, Classification, Movement, Notes, Location=".line …"} }`; exported `addon.dangerousMobs = dangerousMobs[UnitFactionGroup("player")]` (:7281) | `diff` against the classic copy prints 108 lines; Scripts/dangerous_dump.py builds this shape from "Hardcore dangerous mobs - <faction>.csv" |
| DB/forever/StatWeights.lua | 7266 / 323677 | `addon.statWeights[title] = {Title, Class, Spec, MIN_LEVEL, MAX_LEVEL, Kind, ITEM_MOD_*_SHORT = weight, …}`; 192 entries (Kind: 108 Speedrun, 84 Hardcore) | **identical to DB/classic/StatWeights.lua** apart from the gate line and a trailing newline — Classic Era weights, not Forever weights. Unused on Forever (B13) |
| DB/forever/SpiritHealerDB.lua | 117 / 9245 | `SpiritHealerWorld[continent] = { {id, wx, wy, name}, … }` (:5-7) | `diff` against the classic copy prints 3 lines |
| DB/questDB.lua | 1824 / 64064 | quest-log optimiser and "Quest Priority" AceConfig panel (`GetBestQuests` :233ff), `CompleteStep` GM helper (:1752-1820) | uses `RXP.CalculateTotalXP` global (:793, 820); Questie lookups (:873-875, 1675-1677) |

`Scripts/` (excluded from packages by .pkgmeta:2):
- `UiMap.1.15.9.69722.csv`, `UiMapAssignment.1.15.9.69722.csv` — UiMap names/IDs and region bounds; build 1.15.9.69722 in the file name (Classic Era build, inferred).
- `coordinateTransform.py` — converts guide coordinates using those CSVs and `AreaTable.json`/`WorldMapArea.json` (:192-235); walks `Guides/forever` (:334).
- `dangerous_dump.py` — CSV → dangerousMobs Lua (:3-25).
- `stat_weights.py` — CSV "Values leveling - * Classic Era.csv" → `DB/classic/statWeights.lua` (:7-8); no Forever target.
- `dump_locale.py` — extracts `L"…"` strings; `new_locale.lua` — blank translation template (973 lines).

Other provenance notes found: CptStadicsVendorTreasures.lua:1-5 "Derived from https://www.curseforge.com/wow/addons/cpt-stadics-map-of-vendor-treasures / Creative Commons Attribution-NonCommercial 3.0 Unported"; DB/mop/rares.lua:3 (not loaded on Forever) "Taken from … handy-notes-pandaria-treasures".

`CptStadicsVendorTreasures.lua` carries no Forever data. It has no `addon.game` or Forever branch and no new-zone names
(no match for "forever", "Riverglades", "Krol", "Alcaz" or "Blackmaw", case-insensitive). Its data is the Classic vendor
list built by `InitializeZones` (:103ff). It is nevertheless active on Forever by default: its only load gate is
`build > 40000 or GetLocale() == "zhCN"` (:8-9), `enableVendorTreasure` defaults to true (SettingsPanel.lua:199), and it
hooks `WorldMapFrame.OnMapChanged` at file load (:610). So Classic-only vendor pins are shown on Forever unless the player
turns the setting off.

---

## B13. ItemUpgrades and Talents on Forever

### ItemUpgrades
- TOC loads it for camelot (RXPGuides.toc:117), but the file returns early: line 1 `if not _G.GetNumTalentTabs then return end`;
  line 6 `if not (addon.game == "CLASSIC" or addon.game == "TBC" or addon.game == "CATA") then return end`. On Forever
  `addon.game == "FOREVER"`, so **the module is never created** (`addon.itemUpgrades` stays nil; NewModule is at :25).
  Line 10 also limits it to enUS/enGB/frFR clients.
- All callers guard with `if addon.itemUpgrades` (RXPGuides.lua:907, 1011, 1079, 1774; SettingsPanel.lua:2299, 2533-2653), so quest-reward choice falls back to sell value on Forever.
- What it would need: `addon.statWeights` (ItemUpgrades.lua:673-683), `C_Item.GetItemStats or _G.GetItemStats` (:19, called :1067),
  `C_Item.GetItemInfo`, `GetItemInfoInstant`, `IsEquippedItem` (:16-18), `GetInventoryItemLink` (:21), and tooltip hooks
  `GameTooltip/ItemRefTooltip/ShoppingTooltip1:HookScript("OnTooltipSetItem")` (:652-658). Inferred: on a Retail-API client
  `OnTooltipSetItem` may not exist (Retail uses `TooltipDataProcessor`), which would raise an error if the Forever gate were removed. It falls back to `_G.GetItemStats` only when `C_Item.GetItemStats` is absent.
- The same tooltip question already applies on Forever without ItemUpgrades: QuestLog.lua, which loads on Forever with no
  game gate at that point, runs at file load `if _G.TooltipDataProcessor then … AddTooltipPostCall(Enum.TooltipDataType.Item, SetItemTooltip) else _G.GameTooltip:HookScript("OnTooltipSetItem", SetItemTooltip) end`
  (QuestLog.lua:410-415). Which branch Forever takes, and whether the `else` branch is valid there, needs the client (B17 item 4).
- `GetSpellPowerCost` is not referenced anywhere in the addon. `GetItemStats` also appears in functions.lua:9, 7422-7423 with the same C_Item-first fallback.

### Talents
- TOC loads `Talents.lua` and `Guides/Talents/classic.xml` for camelot (RXPGuides.toc:112, 115). `Talents.lua` returns only
  when `gameVersion > 50000` (:3), so the module is created on Forever (:20) and exports `_G.RXPGuides.talents` (:1415).
  It also creates the unprefixed globals `GetTableLength` (:65) and `GetTalentData` (:462) (B5).
- Talent guides are declared as text via `addon.talents.RegisterGuide([[ #name … #minLevel … level -- … .talent tab,row,col,rank ]])`
  (Guides/Talents/classic-warrior.lua:5-30; syntax in Guides/Talents/README.md). Registration is queued until the talent frame opens (Talents.lua:364-380).
- **Every `classic-<class>.lua` returns unless the player is that class and `addon.game == "CLASSIC"`** (line 3 is `if addon.player.class ~= "<CLASS>" or addon.game ~= "CLASSIC" then return end`, e.g. Guides/Talents/classic-warrior.lua:3), so on Forever no talent guides register,
  `IsSupported()` is false (Talents.lua:193-195) and `Setup` returns at :200. Net effect: Talents is loaded but inert on Forever.
- If enabled, it would rely on `PlayerTalentFrame`/`Blizzard_TalentUI` (Talents.lua:202-235), `GetNumTalentTabs`, `GetNumTalents`, `GetTalentInfo` (:1027-1031), `LearnTalent` (:608) — Classic APIs whose presence on Forever is unverified.

### Auction-house UI and Gold Assistant mode
- `UI/V2/AuctionHouse.lua` loads on Forever (B1 step 3) but only defines widget constructors. They are registered by
  `addon.ui.v2:InitializeAuctionHouse` (UI/V2/AuctionHouse.lua:15-17), whose only caller is ItemUpgrades.lua:2156.
  ItemUpgrades returns at line 1 or 6 on Forever, so the auction-house widgets are never registered or built there.
- "GA" is the Gold Assistant mode: a per-character flag `RXPCData.GA` toggled by `addon.GAToggle` (RXPGuides.lua:2482-2490)
  and offered in the guide menu only when `addon.farmGuides > 0` (GuideWindow.lua:2685-2692). `farmGuides` counts guides
  whose group text starts with `+` (GuideLoader.lua:1138-1140). No guide file loaded on Forever has a `#group +…` line
  (text search of the English and translated sets), so the mode is unreachable on Forever unless an imported guide
  supplies such a group.

---

## B14. Questie interop

All uses are optional at runtime. The lookup object is obtained once, `if _G.QuestieLoader then db = _G.QuestieLoader:ImportModule("QuestieDB") end` (functions.lua:493-495); the `ImportModule` call itself is not protected against a loader that lacks that module. The use sites then guard on the object's shape, `db and type(db.QueryQuest) == "function"` (functions.lua:668-669, 834-835, 1240), not on `_G.Questie` existing. `Questie` is an OptionalDep (RXPGuides.toc:21) so it loads first when installed.

| Location | Use |
|---|---|
| functions.lua:493-495 | at file load, `db = QuestieLoader:ImportModule("QuestieDB")`; `addon.questieDB = db` |
| functions.lua:668-672 | quest name lookup `db:GetQuest(id).name` |
| functions.lua:834-861 | build objective list from `q.ObjectiveData`, `db:GetNPC`, `db:GetItem`; each row is tagged `questie = true` (:852), and that flag changes icon choice and text formatting later (functions.lua:1656, 1664) |
| functions.lua:1240-1258, 1453-1480, 1686-1719 | "Missing pre-requisites" tooltip via `db:IsDoable(id)` and required quests |
| DB/questDB.lua:873-889, 1675-1689 | zone lookup `db:GetQuest(id).Zone` in quest-log optimiser output |
| Communications.lua:363-364, 381-382 | suppress complete/collect party announcements when Questie is loaded unless `ignoreQuestieConflicts` |
| SettingsPanel.lua:2195-2201 | `ignoreQuestieConflicts` toggle, hidden without Questie |
| SettingsPanel.lua:3556-3560 | prerequisite-skip option, permanently hidden (`hidden = true or …`) |

No Questie code or data is vendored in the checkout (no match in `libs/`). The two lookup functions do not write
Questie-derived values to the SavedVariables caches: the quest name is returned (functions.lua:668-672) before the
`CacheQuestName` writer is defined (:674-682), and the Questie-built objective table is returned directly (:881) without
going through `questObjectivesCache`. Whether any caller later persists a value it received from these functions was not
traced.

---

## B15. Locale system

- Strings: `locale/<lang>.lua` call `AceLocale:NewLocale(addonName, lang)`; enUS is default with `'raw'` (locale/enUS.lua:4). They also set `BINDING_NAME_*` globals (enUS.lua:6-15).
- `Locale.lua` gets the table (`GetLocale(addonName)`, :9) and sets `addon.locale.Get` to `getForeign` for zhCN, zhTW, frFR, koKR, esES, esMX, ruRU, deDE, ptBR (:49-51), else identity (:53). `getForeign` returns a phrase translation or a word-by-word fallback using `L.words` and `L.delimiter`, cached (:17-41). `AddGenericTranslation` lets code supply translations from Blizzard globals (:56-60; used SettingsPanel.lua:538-560).
- NPC names: `locale/NPCnames.lua` sets `addon.npcNames` per locale and `addon.GetCreatureName` (:4-6, returns for enUS/enGB :8-9).
- Translated guides: TOC loads all five `lang/Guides-<lang>` lists on camelot; each translated file returns unless `GetLocale()` matches (deDE, esES+esMX, frFR, ptBR, zhCN). English files return when `RXP.enabledLocale[GetLocale()]` is true (B6). `enabledLocale` = deDE, esES, esMX, frFR, ptBR and zhCN true, enUS false (RXPGuides.lua:171-183); the Forever branch sets zhCN true again (:207), which is redundant because the base table already has it (:181). So exactly one language copy registers per client.
- `CptStadicsVendorTreasures.lua` returns for zhCN clients (:9); ItemUpgrades only for enUS/enGB/frFR (:10).

---

## B16. Packaging

- `.pkgmeta`: ignore `Scripts`, `Docs`, `readme.md`; `enable-toc-creation: yes` (.pkgmeta:1-6). The ignore list names only those three entries (`Docs` with a capital D). This project's own `docs/`, `tools/`, `tests/`, `node_modules/`, `.tools/`, `CLAUDE.md` and similar files are not listed, so as far as `.pkgmeta` goes a package built today would include them. The packager's built-in default exclusions are not in this checkout, so the exact package contents are not confirmed from source; a packager dry run would settle it.
- `.github/workflows/package.yml`: on push to `main` or any tag, `actions/checkout@v2` (fetch-depth 0) then `BigWigsMods/packager@v2` with `GITHUB_OAUTH`, `CF_API_KEY`, `WAGO_API_TOKEN` secrets (package.yml:1-23).
- Listing identifiers: `## X-Curse-Project-ID: 486246` and `## X-Wago-ID: ZKbebq61` (RXPGuides.toc:24-25; the same lines are in the TBC and Vanilla TOCs, B1) tie a built package to RestedXP's CurseForge and Wago listings.
- Version token: `## Version: @project-version@` in all three TOCs (RXPGuides.toc:9; _TBC:5; _Vanilla:6). At runtime a release string containing "project" becomes `Development` (RXPGuides.lua:159-161); `IsNewRelease` parses `v<maj>.<min>.<patch><letter>` (Communications.lua:286-296). The installed build shows `v4.11.35`; that value was read from the installed TOC, which is outside this checkout (B1), so it cannot be confirmed from the repository.
- `.gitignore` already carries our `# WF:` lines (node_modules, .tools, docs/ENV.md) and upstream's `Guides/Import.lua` entry (.gitignore:2); the file is nevertheless tracked (B1).

---

## B17. Could not determine / needs the game client

1. The numeric value of `WOW_PROJECT_CAMELOT` and `WOW_PROJECT_ID` on Forever (never defined in source).
2. That `select(4, GetBuildInfo())` returns 16001 (or another 16xxx) on Forever — the whole `addon.game == "FOREVER"` path depends on it (RXPGuides.lua:204).
3. Whether `C_SettingsUtil`, `C_EncodingUtil`, `BNGetInfo` (and whether it returns a BattleTag), `GetNumTalentTabs`, `GetTalentInfo`, `LearnTalent`, `issecretvalue`, `C_GameRules` exist on Forever.
4. Whether `TooltipDataProcessor` exists on Forever and, if it does not, whether `OnTooltipSetItem` is a valid script on Forever tooltips. This matters on Forever today: QuestLog.lua:410-415 takes one of the two branches at file load (B13). It would matter again for ItemUpgrades.lua:652-658 if that module were enabled.
5. Who or what writes `RXPString`. A search of engine code finds one read (GuideLoader.lua:814) and no write.
6. Whether the `V2\Manifest.xml` vs `manifest.xml` and `GuideList-Mainline.xml` vs `GuideList-mainline.xml` case mismatches matter (they work on Windows if the CurseForge build loads; untested here).
7. Actual in-client behaviour with both addons loaded: duplicate XML templates, a second `CreateFrame` with a name already in use, AceGUI widget types, macros, global `RXP`/`RXPGuides`, and two addons declaring the same SavedVariables names (B6 is inferred from code, not observed).
8. Load order between two addons when one is a dependency of nothing, and whether the client runs one addon's files to completion before starting the next (inferred alphabetical/sequential; not in source).
9. What `lootSparkle`'s CVars do on Forever and whether they persist (RXPGuides.lua:1545-1553).
10. Settled from source; see B12 (`CptStadicsVendorTreasures.lua` has no Forever data and is active on Forever by default).
11. Settled from source as far as reachability goes; see B13 (the auction-house widgets are never registered on Forever, and Gold Assistant mode needs a guide group starting with `+`, which no Forever guide has). What Gold Assistant mode displays once reached was not read.
12. Contents of the installed v4.11.35 build (not compared by instruction).
13. Whether `unitscanEnabled` is true on Forever. It is false when the global `ShouldShowTargetFrame` exists; otherwise it is true when the trailing digits of the third return of `GetBuildInfo()` (the build date) are below 2025, or when that string does not end in digits (SettingsPanel.lua:22-32). This decides whether the timer-driven `TargetUnit` scan and the suppression of the forbidden-action dialog can run at all (B18 rows A1-A2). Inferred: a client built in 2025 or later yields false.
14. How the client resolves the three manifest path conventions (addon-root-relative `<Script>` paths, paths relative to the XML file, and Lua files loaded with `<Include>`; B1). The upstream addon relies on all three, but nothing in source says how the client treats them, and it affects any manifest we add.
15. Which values the Forever client marks as secret: whether `issecretvalue` exists and returns true for player health, cooldown start/duration and raid-target indexes, and whether `C_Secrets.ShouldAurasBeSecret()` exists and what it returns. The combat-state branches in B18 (rows C1, C3, C4, C6, C7) are guarded by these tests, so whether they execute their logic or silently fall through on Forever depends on the answer.
16. Whether the client treats each automated call in B18 rows A3-A9 as protected or as needing a hardware event (`ConfirmBinder` / `C_PlayerInteractionManager.ConfirmationInteraction`, `TakeTaxiNode`, `AcceptQuest`, `BuyTrainerService`, `GossipSelectOption`, `DeleteCursorItem`, `UseContainerItem`, `DoEmote`). Source shows only that the addon calls them outside a secure template; only for `TargetUnit` do upstream's own comments say the client forbids it (SettingsPanel.lua:498-499; DB/forever/rares.lua:7).

Skimmed rather than read in full: SettingsPanel.lua option groups (only top-level names and the cited toggles), UI/V2/Core.lua, UI/V2/GuideConfigurator.lua (Forever lines only), LevelingTracker.lua outside the cited ranges, InventoryManager.lua outside the cited ranges (`bagManager:Setup` in particular), CptStadicsVendorTreasures.lua body (searched for Forever terms and read at :1-12 and :576-615 only).

---

## B18. Conflicts with this project's rules

This table lists every place found in engine code (root `*.lua`, `DB/*.lua`, `DB/forever/*.lua`, `UI/V2/*.lua`,
`libs/compatibility.lua`) that touches one of CLAUDE.md's hard rules. It was built by text search for the relevant client
functions and events, followed by reading each cited site. Guide files and the bundled third-party libraries were not
searched for combat-state reads. Nothing here was observed in the game client.

Column meanings. "Active on Forever by default" answers whether the code path can run on a fresh install with default
settings, assuming `addon.game == "FOREVER"` (B17 item 2); the controlling setting and its default are given in
parentheses, with defaults from SettingsPanel.lua:127-258 (a setting that is "not in the defaults table" is nil, which the
code treats as off). "Certainty" says whether the answer follows from source alone or needs the client.

| ID | What it does | Where | Active on Forever by default (setting) | Certainty | Relevant rule |
|---|---|---|---|---|---|
| **Combat state: logic that branches on it** | | | | | |
| C1 | Player health threshold. Reads `UnitHealth("player")` and `UnitHealthMax("player")`, computes the ratio and, when it is below `emergencyThreshold`, highlights an emergency item and spell and optionally flashes the screen. Also reads `UnitIsDead("player")` to hide the highlights. Polled from a `WorldFrame` `OnUpdate` hook. When either health value is secret, 0 is substituted and the branch is not taken (:130-132). | Tips.lua:52, 91-120, 122-143 | Yes (`enableTips` true :221; `enableEmergencyActions` true :231; `emergencyThreshold` 0.2 :232) | Setup path certain from source. Whether the values are secret on Forever needs the client (B17 item 15) | No combat logic |
| C2 | Breath timer. Registers `MIRROR_TIMER_START` / `MIRROR_TIMER_STOP`, stores the breath value, polls `GetMirrorTimerProgress("BREATH")`, compares the ratio with `drowningThreshold`, then flashes the screen, flashes the client icon, prints a warning and plays a sound. No secret-value test. | Tips.lua:41-42, 72-89, 96-115 | Yes (`enableTips` true; `enableDrowningWarning` true :224; `drowningThreshold` 0.2 :226) | Certain from source | No combat logic |
| C3 | Active item frame cooldowns. On `SPELL_UPDATE_COOLDOWN` and `PLAYER_REGEN_ENABLED` it reads `GetSpellCooldown` or `GetItemCooldown` for each shown button, tests both values with `IsSecretValue` and for truthiness, then either passes them to the button's Cooldown widget (`SetCooldown`) or clears it. It does no arithmetic on them (the arithmetic is commented out, :187-190). | ActiveItemFrame.lua:178-194, 296-298 | Yes (frame created at login, RXPGuides.lua:1590; hidden when `disableItemWindow`, which is not in the defaults table) | Certain from source that it runs; what the client returns needs the client (B17 item 15) | No combat logic (compare the display-only exception, which forbids branching on the values) |
| C4 | `.cooldown` guide command. Reads the spell, item, action, pet-action or inventory cooldown, returns early if a value is secret or nil, computes the end time (with a Shaman Astral Recall special case), compares it with `GetTime()` and branches. Listens to `SPELL_UPDATE_COOLDOWN` and `PLAYER_REGEN_ENABLED`. | functions.lua:190, 6334-6412 | Yes when the active step uses `.cooldown`; no settings toggle. Text search finds `.cooldown` on 124 lines in 15 of the English guide files loaded on Forever | Certain from source | No combat logic |
| C5 | Cooldown wrapper functions. `addon.GetSpellCooldown` falls back to `C_Spell.GetSpellCooldown` and branches on `isActive` / `isEnabled` when the old global is absent; `addon.GetItemCooldown` has a bag-scanning fallback. They feed C3 and C4. | RXPGuides.lua:54-70; ActiveItemFrame.lua:25-43 | Yes (defined at file load; which fallback is taken depends on the client) | Which branch runs needs the client | No combat logic |
| C6 | `.aura` guide command. Listens to `UNIT_AURA`, scans up to 32 debuffs and buffs on the unit with `UnitDebuff` / `UnitBuff`, compares spell id, stack count, duration and expiration time, schedules a re-check from the expiration time, and completes or holds the step. Returns at once when `C_Secrets.ShouldAurasBeSecret()` is true (:7896-7898). The in-combat early return at :7903 applies only when the interface number is 120000 or higher, so not on Forever. | functions.lua:48-86 (aura wrapper functions), 7860-7935 | Yes when the active step uses `.aura`; no settings toggle. Text search finds `.aura` on 58 lines in 10 of the English guide files loaded on Forever | Certain from source that it is reachable; whether auras are secret needs the client (B17 item 15) | No combat logic |
| C7 | Buff scans for experience-rate detection. `DetectXPRate` runs `CheckBuff(362859)` on clients with interface below 20000 (:3920), and `addon.GetXPBonuses` runs `CheckBuff(377749)` (:3778); `CheckBuff` walks the player's buffs with `UnitBuff` (:3755-3764). Both return or retry when `C_Secrets.ShouldAurasBeSecret()` is true (:3775-3777, 3912-3916). The `C_UnitAuras.GetPlayerAuraBySpellID` reads at :3795 and :3821 are inside the `addon.game == "RETAIL"` branch (:3792). | SettingsPanel.lua:3755-3764, 3774-3778, 3792-3823, 3911-3920 | Yes for the `CheckBuff` scans (`enableAutomaticXpRate` true :153; called from RXPGuides.lua:1744, 1760, 1823). No for the `RETAIL`-only reads | Certain from source; whether auras are secret needs the client | No combat logic |
| C8 | Aura scans in waypoint callbacks. `ironchain` scans the vehicle's auras for spell 133273; `wpbuff` scans the player's auras for a buff id given in the guide line. | functions.lua:6706-6722, 6769-6780 | No in shipped guides: text search finds no `,ironchain` or `,wpbuff` callback in the English guide files loaded on Forever. Reachable from any guide text | Certain from source | No combat logic |
| C9 | Dead and ghost state. (a) `addon.SelectGossipType("healer")` picks the healer gossip option only when `UnitIsDeadOrGhost("player")` (functions.lua:2630-2650; called from `.deathskip` at :2947). (b) `.showwhiledead` completes the step on `PLAYER_ALIVE` / `PLAYER_UNGHOST` when the player is no longer dead (functions.lua:8605-8615). (c) The arrow switches to a corpse or spirit-healer waypoint while `UnitIsGhost("player")` (map.lua:1060, 1224). (d) Inventory sorting and junk deletion are skipped while `UnitIsDead("player")` (InventoryManager.lua:303, 568). (e) Marker update is skipped for a dead non-friendly unit (Targeting.lua:980; on Forever the function returns at :985 before marking in any case). (f) The levelling tracker counts deaths on `PLAYER_DEAD` (LevelingTracker.lua:96, 335-341). | as cited | (a) Yes when the active step uses `.deathskip` (no settings test, see A5). (b) Yes when a step uses it (10 lines in 1 English guide file). (c) Yes, no toggle. (d) Yes (`enableInventoryManager` true :200). (e) The read runs; the marking does not. (f) Yes below maximum level (`enableTracker` true :129) | Certain from source | No combat logic |
| C10 | Spellcast events. `.hs` completes on `UNIT_SPELLCAST_SUCCEEDED` for hearthstone spell ids (functions.lua:127, 2605-2608). `.tame` tracks `UNIT_SPELLCAST_START` / `SUCCEEDED` for spell 1515 (functions.lua:144, 3806-3814). `.cast` completes on `UNIT_SPELLCAST_SUCCEEDED` or, with a fail check, `UNIT_SPELLCAST_FAILED_QUIET` for listed spell ids (functions.lua:203, 4885-4891). HSBatching listens to `UNIT_SPELLCAST_INTERRUPTED` for spell 8690 and calls `IsCurrentSpell(8690)` / `IsCurrentSpell(556)` inside its `UseAction` hook (HSBatching.lua:71-81, 115-119). | as cited | `.hs`, `.tame`, `.cast`: yes when the active step uses them (text search: 125, 4 and 209 lines in the English Forever guide files); no toggle. HSBatching: the event is registered and the hook installed at file load regardless of settings; its effect needs `enableHSbatch` (not in the defaults table) | Certain from source | No combat logic |
| C11 | Combat-enter event used to disable a button. On `PLAYER_REGEN_DISABLED` the quest-log cleanup button is disabled and on `PLAYER_REGEN_ENABLED` it is re-enabled. This is a lockdown-style guard rather than gameplay logic, but it is the one place that registers the combat-enter event. | QuestLog.lua:851-852, 884-888 | Yes (file-level frame, no toggle) | Certain from source | No combat logic (guard form; see G1) |
| **Combat state: reads used only as a "wait until out of combat" guard (permitted)** | | | | | |
| G1 | `InCombatLockdown()` tests and `PLAYER_REGEN_ENABLED` handlers that defer frame, macro or panel work until combat ends. Read in full: GuideLoader.lua:1419-1424 with RXPGuides.lua:1874-1887 (importer and settings panel), SettingsPanel.lua:63-67, InventoryManager.lua:49-52, Targeting.lua:180-183 (macro edit), Targeting.lua:581, ActiveItemFrame.lua:344, 378, SettingsPanel.lua:1752. Found by search and not read in full: ActiveItemFrame.lua:282, 286, 364, 368; Communications.lua:56, 129-139; InventoryManager.lua:262-263, 598; LevelingTracker.lua:1114; QuestLog.lua:796, 807, 815; RXPGuides.lua:1668, 1982; SettingsPanel.lua:1639, 3740; Targeting.lua:78, 276, 308, 1134. | as cited | Yes | Certain for the sites read in full; the others are classed as guards from the search line only | Protected actions need a player click (this is the permitted guard) |
| G2 | Secret-value tests that only skip work: `addon.IsSecretValue` (wraps `issecretvalue`, libs/compatibility.lua:3-5) on a raid-target index (Targeting.lua:532, 989), on chat message text (LevelingTracker.lua:203), on a tooltip line (functions.lua:906) and on a unit name (libs/compatibility.lua:7-13). | as cited | Yes | Certain from source | No combat logic (context for B17 item 15) |
| **Protected or automated actions without a dedicated player click** | | | | | |
| A1 | Timer-driven targeting. `C_Timer.NewTicker` calls `CheckTargetProximity`, which calls `TargetUnit(name, true)` for every unitscan, mob, friendly and rare name and treats the resulting `ADDON_ACTION_FORBIDDEN` event as "the unit is nearby". The option text says "This relies on ADDON_ACTION_FORBIDDEN errors from TargetUnit() to function" (SettingsPanel.lua:1760). | Targeting.lua:115-120, 541-568, 596-625 | Unknown. Needs `enableTargetAutomation` (true :176), `showTargetingOnProximity` (default equals `unitscanEnabled`, :191) and `addon.unitscanEnabled` (Targeting.lua:542). A migration forces the setting off when `unitscanEnabled` is false (SettingsPanel.lua:498-503) and the option is then hidden (:1772) | Needs the client (B17 item 13). Upstream comments say the client forbids the call at execution on recent builds (SettingsPanel.lua:498-499; DB/forever/rares.lua:7) | Protected actions need a player click |
| A2 | Suppression of the client's forbidden-action dialog. In the same branch as A1, when `StaticPopupDialogs["ADDON_ACTION_FORBIDDEN"]` exists, the addon hooks `StaticPopup1` and `StaticPopup2` `OnShow` / `OnHide` to hide the dialog and stop its sound, sets `StaticPopupDialogs["ADDON_ACTION_FORBIDDEN"] = nil`, registers the event for itself and calls `UIParent:UnregisterEvent("ADDON_ACTION_FORBIDDEN")`, which removes the client's default handling of that event for every addon. | Targeting.lua:122-151 | Unknown; same conditions as A1 | Needs the client (B17 item 13) | Protected actions need a player click |
| A3 | Hearthstone batching. Hooks on item-use and spell-cast functions start a timer; an `OnUpdate` script then calls `ConfirmBinder()` (or `C_PlayerInteractionManager.ConfirmationInteraction`) at a computed moment and raises `maxfps` to 300 meanwhile. | HSBatching.lua:16-41, 54-69, 83-134 | Hooks: yes, installed at file load regardless of settings. Effect: no (`enableHSbatch` not in the defaults table; option at SettingsPanel.lua:3431) | Certain from source; whether the confirm call is protected needs the client (B17 item 16) | Protected actions need a player click; Everything is optional |
| A4 | Innkeeper bind automation. `.home` confirms the bind on the `CONFIRM_BINDER` event, from an `OnUpdate` script or by calling `ConfirmBinder()`. Skipped while Shift is held. | functions.lua:2666-2710 | Yes when the active step uses `.home` (`enableBindAutomation` true :147, tested at :2682) | Certain from source; protected status needs the client | Protected actions need a player click |
| A5 | Spirit-healer automation. `.deathskip` confirms the resurrection prompt (`ConfirmationInteraction(SpiritHealer)` from an `OnUpdate` script, or `AcceptXPLoss()`) and selects the healer gossip option. No settings test in the handler. | functions.lua:2916-2948 | Yes when the active step uses `.deathskip` (text search: 94 lines in 16 English Forever guide files) | Certain from source; protected status needs the client | Protected actions need a player click |
| A6 | Flight automation. `.fp` / `.fly` call `TakeTaxiNode(i)` when the taxi map opens. Skipped while Shift is held. | functions.lua:2763-2892 (call at :2890) | Yes when the active step uses it (`enableFPAutomation` true :146, tested at :2866, 2873) | Certain from source; protected status needs the client | Protected actions need a player click |
| A7 | Quest, gossip and trainer automation. `AcceptQuest()` in the quest event handler (RXPGuides.lua:1087-1200); `GossipSelectOption(i)` in `addon.SelectGossipType` (functions.lua:2630-2650), which is called from `.home` (:2712), the flight commands (:2836, 2871), `.deathskip` (:2947) and the trainer command (:5722) under those commands' own gates; other gossip commands test `enableGossipAutomation` (functions.lua:5702, 5860, 5950; not read in full); `BuyTrainerService` (RXPGuides.lua:585-680; functions.lua:7228). | as cited | Quest: yes (`enableQuestAutomation` true :145, tested at RXPGuides.lua:1089). Gossip: yes (`enableGossipAutomation` true :148, or the calling command's gate). Trainer: no (`enableTrainerAutomation` is not in the defaults table; tested at RXPGuides.lua:647) | Certain from source for the settings; protected status needs the client | Protected actions need a player click |
| A8 | Inventory manager item actions. Junk deletion (`PickupContainerItem` then `DeleteCursorItem()`), opening queued containers (`UseContainerItem`) and selling (`PickupContainerItem` then `PickupMerchantItem`) run from hooks on `WorldFrame` `OnMouseDown` / `OnMouseUp`, so any click in the world drives them, and from the `RXPInventory_DeleteJunk` binding button. The module also calls `SetBinding`. | InventoryManager.lua:85-86, 146-147, 561-584, 614-635, 653-666, 853-856 | Module: yes (`enableInventoryManager` true :200, subject to `IsFeatureEnabled`, :267-270). Automatic deletion on world clicks: no (`autoDiscardItems` not in the defaults table; turned on by "Enable Group Settings", SettingsPanel.lua:830) | Certain from source for the settings; whether a bag adapter is available and whether the calls are protected need the client | Protected actions need a player click |
| A9 | `.emote` guide command calls `DoEmote` when the step is active. | functions.lua:6254-6287 | No in shipped guides (no `.emote` in the English guide files loaded on Forever); reachable from any guide text; no toggle | Certain from source | Protected actions need a player click |
| A10 | Raid-target marking with `SetRaidTarget`. | Targeting.lua:530-533, 985-990 | No: both functions return first when `addon.game == "FOREVER"` | Certain from source | Protected actions need a player click |
| A11 | Talent automation with `LearnTalent`. | Talents.lua:608, 695, 761 | No: no talent guide registers on Forever, so `Setup` returns (B13) | Certain from source | Protected actions need a player click |
| **Hooks on client functions and frames** | | | | | |
| H1 | HSBatching hooks, installed at file load whatever the settings: `UseContainerItem`, `UseItemByName`, `CastSpellByName`, `CastSpellByID`, `UseAction`, and the `CONFIRM_BINDER` popup's `OnCancel` / `OnAccept`. | HSBatching.lua:84-134 | Yes | Certain from source | Everything is optional |
| H2 | Replacement (not a secure hook) of the client functions `ChatFrame_DisplayTimePlayed` and `ChatFrameUtil.DisplayTimePlayed` to hide `/played` output, at file load. | LevelingTracker.lua:27-54 | Yes, regardless of `enableTracker` | Certain from source | Everything is optional |
| H3 | Hooks installed at file load without a settings test: `TaxiNodeOnButtonEnter` and `TakeTaxiNode` (Timers.lua:296, 314; the first tests `showFlightTimers` inside); `WorldMapFrame.OnMapChanged` (CptStadicsVendorTreasures.lua:610; map.lua:1209); `QuestLog_SetSelection` when it exists (QuestLog.lua:173-175); item tooltip post-call or `OnTooltipSetItem` (QuestLog.lua:410-415); `ToggleQuestLog` or `WorldMapFrame` `OnShow` (QuestLog.lua:869-877, 897). | as cited | Yes | Certain from source that the code runs; which functions exist on Forever needs the client | Everything is optional |
| H4 | Hooks installed inside a gated setup: `WorldFrame` `OnUpdate` (Tips.lua:52, `enableTips`); `WorldFrame` `OnMouseDown` / `OnMouseUp`, `ToggleAllBags`, `ToggleBag`, backpack button, `ContainerFrame_Update` and third-party bag addons (InventoryManager.lua:132-157, 1134-1307); `NotifyInspect` (LevelingTracker.lua:121, needs `enableBetaFeatures`); `SelectQuestLogEntry` and quest frame scripts (RXPGuides.lua:808-856, not read in full). Nothing in source removes these hooks when the setting is switched off later. | as cited | Tips and InventoryManager: yes (defaults true). `NotifyInspect`: no | Certain from source for the cited gates | Everything is optional |
| H5 | `StaticPopup1` / `StaticPopup2` script hooks and `UIParent:UnregisterEvent` (see A2). | Targeting.lua:142-150 | Unknown (as A2) | Needs the client | Everything is optional; Protected actions need a player click |
| H6 | Console variables written by the engine: `nameplateMaxDistance` (Targeting.lua:107-112), `questPOI` (RXPGuides.lua:1500-1504), `scriptErrors` (GuideLoader.lua:1528, 1542; SettingsPanel.lua:3384), `maxfps` (HSBatching.lua:27, 38, 64), five outline CVars for `lootSparkle` (RXPGuides.lua:1545-1553). Details and defaults in B10. | as cited | `nameplateMaxDistance`: yes (two settings, both default true). `questPOI`: yes, once, on a character's first login. The others: no by default | Certain from source | Everything is optional |
| **Obfuscation and the import path (B7)** | | | | | |
| O1 | Account-bound encrypted guide import: keyed stream cipher, key derived from the second return of `BNGetInfo`, entry points in the options panel, guide menu, configurator and slash command. | GuideLoader.lua:380-464, 590-646, 1419-1711; UI/V2/GuideImporter.lua; entry points in B7 | Yes (entry points are present; nothing gates them) | Certain from source; whether `BNGetInfo` and `C_EncodingUtil` exist needs the client (B17 item 3) | No obfuscation |
| O2 | Import and cache loading that run at login without user action: automatic import from `RXPString` and re-validation of cached guides. | GuideLoader.lua:814-877, 880-944; RXPGuides.lua:1601 | Yes (the loops do nothing when `RXPString` is unset and the cache is empty) | Certain from source | No obfuscation |
| O3 | Function name hidden as a byte table: `addon.base = {66,78,71,…}` spells `BNGetInfo` and is called through `_G[addon.DeserializeTable(addon.base)]()`. | DB/shared.lua:37; GuideLoader.lua:370-376, 592; UI/V2/GuideImporter.lua:604 | Yes | Certain from source | No obfuscation |
| O4 | Stored data that is not readable text: imported guides are kept deflate-compressed in `RXPDB.profile.guides`; the account value or derived key is kept in `RXPData.cache` (the raw second return of `BNGetInfo` when stored by the importer UI). | GuideLoader.lua:477-496, 593-594, 618; UI/V2/GuideImporter.lua:601-604 | Only after an import, or after the importer UI is opened (for `RXPData.cache`) | Certain from source | No obfuscation |
| O5 | Public global `_G.RXPGuides.ImportGuide` lets any addon or `/run` command import and cache guide text without the user interface. | GuideLoader.lua:499-520, 1389-1394 | Yes | Certain from source | No obfuscation |
| O6 | `loadstring` on guide text: the `#setquestdb` command compiles and runs `"return " .. str` in an empty environment. | DB/questDB.lua:1150-1158 | No in shipped guides (no `#setquestdb` in the English guide files loaded on Forever); reachable from any guide text | Certain from source | No obfuscation |
| **Outbound, branding and commercial elements (B8, B9)** | | | | | |
| E1 | "Join Discord" button showing `https://discord.gg/restedxp`, and the feedback form's Discord line and RestedXP titles. | SettingsPanel.lua:594-604; Communications.lua:600, 611, 632 | Yes (shown when the panel or form is opened) | Certain from source | Free forever (no in-game ads or links); Licence (credit RestedXP in NOTICE.md, not in the UI) |
| E2 | Chat sent on the player's behalf with the addon title as prefix ("RestedXP Guides: …"): flight announcements to the party, and level-up and step announcements when enabled. | Communications.lua:26-36, 147-181, 345-409, 415 | Flight announcements: yes (`enableFlyStepAnnouncements` true :132 and `alwaysSendBranded` true :133). Others: no by default (B9) | Certain from source | Free forever (no in-game ads) |
| E3 | Addon messages to the party on login and group formation carrying name, class, level, experience percentage, addon release and guide name and version; "new version" notices on receipt. | Communications.lua:94-110, 236-275, 319-343 | Yes (no gate beyond being in a group; `checkVersions` true :134) | Certain from source | Free forever (branding); Everything is optional |
| E4 | No string for "paid", "premium", "purchase", "patreon", "donate", "subscribe" or "shop" in engine or locale code apart from vendor-buy code (functions.lua:5670-5672). The commercial link is structural: the account-bound import path (O1), inferred to deliver non-public guides. | B7, B8 | — | The absence is certain from search; the purpose of the import path is inferred | Free forever; Do not copy protected content |
| E5 | Packaging identifiers and names that tie a build to RestedXP's listings: `X-Curse-Project-ID`, `X-Wago-ID`, `Title`, `Author`. | RXPGuides.toc:5-8, 24-25 | Applies at packaging, not in game | Certain from source | Licence (state that files were changed) |
| **Licences of bundled components (B3, B12, B14)** | | | | | |
| L1 | LibDeflate: the source file states the zlib licence, but `libs/LibDeflate/LICENSE.txt` is the GNU LGPL v3 text. | libs/LibDeflate/LibDeflate.lua:9, 30ff; libs/LibDeflate/LICENSE.txt:1-5 | Loaded on Forever (B1 step 1) | The contradiction is certain from source; which licence governs is not | Licence; No GPL data |
| L2 | Libraries loaded on Forever whose own files carry no licence statement: CallbackHandler-1.0, LibUIDropDownMenu, AceEvent, AceDB, AceAddon, AceGUI, AceConfig, AceComm, AceSerializer, AceConsole, AceLocale, AceDBOptions, HereBeDragons (`X-License: BSD` only in its unloaded TOC), LibCandyBar, LibDataBroker, LibDBIcon. | B3 table | Loaded on Forever | Certain from source that no statement is in the files; the actual licences are not in the checkout | Licence (never add code whose licence is unknown) |
| L3 | `plc/base64.lua`: MIT-style permission text without a licence name; the file was modified by RestedXP. | libs/plc/base64.lua:1, 3, 56; libs/plc/LICENSE:1-22 | Loaded on Forever | Certain from source | Licence |
| L4 | `CptStadicsVendorTreasures.lua` states it is derived from a CurseForge addon under CC BY-NC 3.0 Unported. | CptStadicsVendorTreasures.lua:1-5 | Loaded and active on Forever (B12) | Certain from source that the header says so; compatibility with CC BY-NC-SA 4.0 is a licence question | Licence |
| L5 | Data files with no stated source: nothing under `DB/forever/`, `DB/shared.lua` or `DB/questDB.lua` names where its data came from. | B12 | Loaded on Forever | Certain from source that no header exists; the origin is unknown | Licence; No GPL data |
| L6 | Questie: used only through optional runtime calls when the player has it installed; no Questie code or data is vendored. | B14 | Only with Questie installed | Certain from source | No GPL data (this is the permitted form of use) |

Not conflicts, listed so the search is complete. The targeting macros `RXPTargeting` and `RXPFollow` are static macro
text (`/targetexact …`, `/follow`) that the player runs with a click or key press, and the target buttons are secure
`macro`-type buttons (Targeting.lua:57-70, 214-255, 281-303); their creation and editing are deferred while
`InCombatLockdown()` is true (Targeting.lua:180-183, 276). `RXPFollow` is created only when `createFollowMacro` is on (not
in the defaults table; Targeting.lua:90-97). `CHAT_MSG_COMBAT_XP_GAIN` (LevelingTracker.lua:93) is an experience chat
event, not combat state. No use of `UnitAffectingCombat`, threat functions, `UnitCastingInfo`, `UnitChannelInfo` or the
combat log was found in engine code.

---

# Review record

The first draft of this document was written on 2026-11-16 by two agents
reading the source. Three other agents with fresh context then checked it
against the source, and two editors applied their findings after re-checking
each one in the source.

| Part | Findings | Applied as written | Applied differently or in part | Not applied or no change needed |
|---|---:|---:|---:|---:|
| A1–A5 | 51 | 45 | 4 | 2 |
| A6–A11 | 43 | 38 | 5 | 0 |
| B1–B17 | 55 | 45 | 7 | 3 |

Findings by class, all parts: 36 wrong statements, 21 wrong citations (most
off by one to three lines), 13 statements the reviewer could not confirm,
63 omissions, 16 weak inferences.

Where a reviewer and the source disagreed, the source was followed: the
`#season` count stays 89, the zone argument of `.goto` cannot be omitted,
`Locale.lua:49` does include ruRU, and the `SetCVar` hook in
`HSBatching.lua` is inside a block comment.

Limits of the review:

- Reviewer coverage, by the reviewers' own estimates: in A1–A5 every
  statement outside the element-function table (about 227), every row of
  that table for existence and citation, and the function bodies of 105 of
  the 178 names; about 175 of 190 statements in A6–A11; about 407 of 473 in
  Part B.
- The Arguments and Meaning columns of about 70 element functions that no
  Forever guide uses were not read (A5.3).
- The editor of Part B re-read sections B4 and B5 after editing and checked
  the rest mechanically; it did not re-read the whole part.
- Statements that remain unconfirmed from source are marked in place and
  collected in A11 and B17.
- Nothing in this document has been tested in the game client.
