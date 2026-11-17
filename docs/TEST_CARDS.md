# TEST_CARDS.md — in-game tests for Don

Short cards, one per gate. Each ends with `/reload` so SavedVariables reach
disk. Nothing on a card is confirmed until Don reports it.

Before any card, turn on error pop-ups once:

```
/console scriptErrors 1
```

If you use BugSack and BugGrabber, keep them enabled; their log is read
after the test.

## T0 — client facts (2 minutes, no addon changes)

Log in on Forever with the Troll. Type each line and send the output.

```
/dump (select(4, GetBuildInfo()))
/dump WOW_PROJECT_ID, WOW_PROJECT_CAMELOT
/dump UnitRace("player")
```

Expected, not yet observed: a number from 16000 to 19999; `18, 18`;
`"Troll", "Troll"`.

## T1 — Wayfinder loads next to RestedXP (P1 gate, about 15 minutes)

Gate: the addon loads on Forever next to RestedXP with zero Lua errors, and
the upstream Durotar guide runs for a fresh Troll.

Install (game closed, or at the character screen):

```
powershell -ExecutionPolicy Bypass -File tools\dev\install.ps1
```

It builds the addon and copies it to `_forever_\Interface\AddOns\Wayfinder`.
It does not touch the `RXPGuides` folder. Leave RestedXP enabled.

On a new level 1 Troll Warrior:

| # | Do | Expect | Result |
|---|---|---|---|
| 1 | Log in | No Lua error. Both Wayfinder and RestedXP Guides are listed under AddOns | |
| 2 | Look at the screen | Wayfinder's guide picker opens (a level 1 character with no guide) | |
| 3 | Pick the Durotar 1–6 guide | A step window titled Wayfinder and a waypoint arrow appear | |
| 4 | Accept the first quest the guide names | The step ticks and the guide moves on | |
| 5 | Kill or collect for the next step, turn in | Steps complete without manual ticks | |
| 6 | Type `/wf` | Wayfinder's options open. The first page shows "Based on RestedXP Guides …" | |
| 7 | Type `/rxp` | RestedXP's options open, not Wayfinder's | |
| 8 | Right-click the Wayfinder minimap button | A menu opens. Note whether it looks like the old dropdown or the new Blizzard menu | |
| 9 | Drag the minimap button, then left-click it | It moves around the minimap edge; the click shows or hides the guide window | |
| 10 | Right-click the step window, open the guide list | Menus open; no "Import guide" entry anywhere | |
| 11 | Open the macro window | Macros named `WFTargeting` (and `RXPTargeting` from RestedXP) are separate | |
| 12 | Check Key Bindings | There is a Wayfinder section separate from RestedXP's | |
| 13 | Use an item the guide shows as a button (if any) | The button works; note whether a cooldown swipe shows | |
| 14 | Type `/reload` | No Lua error; the guide resumes on the same step | |

Things that are meant to differ from RestedXP:

- No guide import, no Discord button, no low-health or drowning warnings.
- Steps that upstream skipped by hearthstone cooldown or by buff no longer
  skip themselves. Skip them by hand and note which ones.
- Settings and window positions start fresh.

Send back: the Result column, the full text of any error, and say when you
have reloaded. Claude Code then reads
`_forever_\WTF\Account\<account>\SavedVariables\Wayfinder.lua` and the
BugGrabber log.
