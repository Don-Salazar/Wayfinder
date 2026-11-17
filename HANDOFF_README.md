# Handoff setup — do this once, before the first Claude Code session

Snapshot: 2026-11-16. Working name: Wayfinder.

## What you need installed

- Git, and a GitHub account.
- VS Code with the Claude Code extension.
- World of Warcraft: Forever, with your Troll Warrior.
- Claude Code will ask to install the rest (Node.js tooling, Lua linters) in
  its first phase.

## Steps

1. **Fork the upstream addon.** On GitHub, open
   `github.com/RestedXP/RXPGuides`, press Fork, name the fork (for example
   `wayfinder`) and keep it public.

2. **Clone your fork** to a working folder that is NOT inside the WoW
   install, for example:

   ```
   git clone https://github.com/<your-user>/wayfinder.git C:\Dev\wayfinder
   ```

3. **Unzip `wayfinder-handoff.zip` into the root of that clone**, so that
   `CLAUDE.md` sits beside the upstream file `RXPGuides.toc`. If Windows asks
   whether to merge the `docs` folder, say yes. If a file of ours has the
   same name as an upstream file, keep ours and tell Claude Code.

4. **Add the research workbook.** Open the spreadsheet
   "WoW: Forever Addon — Verified Information"
   (https://claude.ai/artifact/4stuB1hLzdXoawxLJdHxDJ), download it as
   `.xlsx` from the page, and save it as:

   ```
   docs\research\verified.xlsx
   ```

5. **Check the layout.** It should look like this:

   ```
   wayfinder\
   ├─ CLAUDE.md                  standing rules for every session
   ├─ KICKOFF_PROMPT.md          the first message to paste
   ├─ HANDOFF_README.md          this file
   ├─ RXPGuides.toc, *.lua, Guides\, ...   (upstream files from the fork)
   └─ docs\
      ├─ DESIGN.md               product and architecture
      ├─ PIPELINE.md             phases, gates, in-game loop
      ├─ RESEARCH_INDEX.md       what each workbook tab is and how far to trust it
      ├─ FIELD_LOG.md            the play log and the correction loop
      └─ research\
         └─ verified.xlsx        the workbook you downloaded
   ```

6. **Have three facts ready.** Claude Code asks for them in its first
   message:
   - the URL of your fork;
   - the WoW install folder (the one that contains `_forever_`);
   - your account folder name: the folder inside
     `_forever_\WTF\Account\` (it is created after you have logged in once).

7. **Start.** Open the `wayfinder` folder in VS Code, open Claude Code, and
   paste the block from `KICKOFF_PROMPT.md` as your first message.

## What happens next

| Phase | What Claude Code does | What you do |
|---|---|---|
| P0 Bootstrap | Sets up tooling, reads the upstream source, converts the workbook | Answer its one setup message |
| P1 Rebrand | Renames and strips the fork to a Forever-only addon | T1: log in, confirm it loads with no errors |
| P2 Self-test, dump, field log | Builds the checks, the data dump and the play log | T2: run `/wf selftest` and `/wf dump`, visit a Warrior trainer, `/reload` |
| P3 Troll Warrior 1-22 | Guide, macros, options page, opportunities, cooldown strip | T3: play 1-22 with the field log on |
| P4-P6 | 22-60 from your recordings | Play each band with the recorder on |

After every in-game session, type `/reload` (or log out) so the log is
written to disk, then tell Claude Code you are done. It reads the log and
reports what it found.

## If something is missing

- No `verified.xlsx`: Claude Code can start P0 and P1 without it, but must
  not write guide or item data until it is there.
- The fork is private: fine for development; the addon must be public before
  release because its licence requires sharing under the same terms.
