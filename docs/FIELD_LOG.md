# FIELD_LOG.md — the play log and the correction loop

Added 2026-11-16 at Don's request. Purpose: every test run produces a log that
Claude Code can analyze to find bugs, wrong guide data and slow routing, so
the guide gets more accurate and faster with each session.

## 1. What it is

`Modules/FieldLog.lua` writes a structured event log into SavedVariables while
the player plays. `tools/analyze-log` (off-game) turns one or more logs into a
corrections report and proposed guide patches. Nothing leaves the player's
computer: addons have no network access, and sharing a log means copying a
file by hand.

It differs from the Recorder. The Recorder captures a route where no guide
exists yet. The Field log measures a guide that does exist against what
actually happened. They share one event writer.

## 2. Constraints

- Lua cannot write files. The log lives in the addon's SavedVariables and is
  written to disk only at logout or `/reload`. Test cards must end with
  `/reload`.
- Forever hides combat state from addons. The log never contains health,
  auras, cooldowns or enemy casts, and must not try to read them.
- Size: ring buffer per character, default cap 20,000 events, oldest dropped
  first. Field names are short keys; positions are rounded to 0.1.
- Privacy: no chat, no other players' names. Character name and realm are
  replaced by a per-install random ID unless the player turns that off.
- Off by default in release builds, on in development builds. It is one entry
  in the options table (DESIGN § 6).

## 3. Events

Every event has `t` (seconds since session start), `lv` (level), `m`
(UiMapID), `x`, `y`.

| Event | Extra fields | What it lets us correct |
|---|---|---|
| `session` | addon version, guide file + content hash, client build, interface, locale, race, class, spec, options snapshot | Ties findings to an exact guide version |
| `step_show` | step id, kind, quest id, target x/y | Baseline for timing |
| `step_done` | step id, seconds on step, distance from the step's target at completion, how it completed (auto, manual tick) | Wrong coordinates; steps that never auto-complete |
| `step_skip` | step id, seconds on step, reason if given | Broken or unwanted steps |
| `quest_accept` | quest id, NPC or object name, in guide? | Quest IDs, quest givers, quests missing from the guide |
| `quest_absent` | step id, quest id, seconds waited | An `.accept` step whose quest was never offered: wrong faction, missing prerequisite, wrong level |
| `quest_turnin` | quest id, xp, money, reward item chosen, in guide? | Quest XP values; reward choices |
| `xp` | amount, source (quest, kill, explore, other) | XP per hour by segment and by source |
| `level` | new level, /played seconds | Pace against the plan |
| `travel` | kind (flight, hearth, boat, zeppelin, death run), from, to, seconds | Travel-time assumptions |
| `death` | step id | Steps that are too dangerous at the planned level |
| `train` | spell id, rank, cost | Trainer data on the Spell IDs tab |
| `talent` | talent, rank, matched suggestion? | Whether players follow the build |
| `equip` | slot, item id, was a tracked hunt?, score before and after | Stat weights; gear hunt predictions |
| `opportunity` | id, shown / taken / dismissed, seconds spent | Ranking of optional tasks (DESIGN § 5.8) |
| `macro` | macro id, installed / failed, reason | Macro installer bugs |
| `probe` | name, result | Self-test results, kept with the session |
| `error` | message, stack, module, count | Lua errors in our code |
| `blocked` | function name, addon | `ADDON_ACTION_BLOCKED` / `FORBIDDEN`: taint bugs |
| `note` | text, current step id | The player's own words: `/wf note <text>` or the "report a problem" button |

Errors: wrap our module entry points and event handlers in a guarded call
that logs message and stack, then re-raises to the default handler. If
BugGrabber is installed, also subscribe to its callback. Do not replace the
global error handler.

## 4. Analysis (`tools/analyze-log`)

Input: one or more SavedVariables files. Output: `docs/reports/<date>-<id>.md`
plus `docs/reports/<date>-<id>.patch.md` with proposed guide edits.

The report has fixed sections so runs can be compared:

1. **Errors and blocked actions**, grouped by message, with counts and the
   step that was active.
2. **Guide data corrections**
   - coordinate drift: steps completed more than 25 yards from their target,
     with the median completion position as the proposed fix;
   - quest never offered (`quest_absent`): list with level and race;
   - quests accepted or turned in that the guide does not contain;
   - quest XP that differs from the workbook value;
   - steps that needed a manual tick or a skip.
3. **Pace**
   - XP per hour per guide segment, and the ten slowest steps by XP per
     minute;
   - travel time by leg; deaths by step;
   - level timeline against the planned bands.
4. **Choices**: which optional tasks, gear hunts and suggested talents were
   taken, and the time each cost.
5. **Research reconciliation**: workbook rows this log confirms or
   contradicts, ready to be marked "Confirmed in game".

Rules for acting on a report:
- A proposed guide change needs evidence from the log (event ids) in the
  commit message. One session is enough for an error or a wrong ID; routing
  changes for speed want two sessions or a clear margin.
- The guide reviewer agent checks every proposed patch before it merges.
- After a fix, the next session's report must show the finding gone. Findings
  that reappear are listed first.

## 5. The loop

1. Claude Code builds, writes a test card, Don plays with the Field log on.
2. Don types `/reload` (or logs out) so the log reaches disk.
3. Claude Code runs `tools/read-savedvars` then `tools/analyze-log`, reads the
   report, proposes patches, and lists questions for Don.
4. Patches are reviewed and merged; the report is committed under
   `docs/reports/`.
5. Next session verifies the fixes.

Later, if Don accepts community logs (DESIGN § 7), the same analyzer runs
over many logs and weights findings by how many independent characters show
them.
