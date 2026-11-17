# Kickoff prompt for Claude Code

Paste the block below as the first message in a new Claude Code session opened
in the project folder prepared by `HANDOFF_README.md`: a clone of your GitHub
fork of RXPGuides with `CLAUDE.md`, `docs/DESIGN.md`, `docs/PIPELINE.md`,
`docs/RESEARCH_INDEX.md`, `docs/FIELD_LOG.md` and
`docs/research/verified.xlsx` added.

---

You are the orchestrator for a free World of Warcraft: Forever addon that
forks RestedXP's open-source addon. `CLAUDE.md` has the standing rules;
`docs/DESIGN.md` is the product and architecture; `docs/PIPELINE.md` is the
phased build with gates; `docs/RESEARCH_INDEX.md` describes the research
workbook in `docs/research/verified.xlsx` and how far each tab can be trusted;
`docs/FIELD_LOG.md` specifies the play log and the correction loop.
Read all five fully before doing anything.

Start Phase P0 only. Specifically:

1. Ask me, in one message, for every input listed in PIPELINE § 0 that you
   cannot find in `docs/ENV.md`. Proceed with the working name if I do not
   give a final one.
2. This folder is already a clone of my fork of github.com/RestedXP/RXPGuides.
   Add the upstream remote, set the repo up as described in P0, and get lint
   and CI running on the unmodified engine code.
3. Read the upstream source directly and write `docs/UPSTREAM_MAP.md`. Have a
   second agent with fresh context check it against the source and list any
   claim it could not confirm.
4. Compare what you found with the engine notes in `docs/research/`. Where
   they differ, the source wins: correct the research file and list the
   differences for me.
5. Stop at the P0 gate and report: what passed, what you could not verify,
   and the P1 plan with the full identifier inventory.

Constraints that matter most: never invent quest, item, NPC or map IDs or
coordinates; never copy Questie or any GPL data into the repo; treat the
research workbook as a seed that the in-game dump or a recording must confirm
before anything ships; never copy third-party guide or macro text; keep the diff against
upstream small and tagged; say "untested in client" for anything I have not
run in the game. You cannot run the game; I am the in-game tester, so give me
short test cards.

---

## Notes for Don

- Use your most capable model for the orchestrator and the guide reviewer;
  smaller models are fine for the researcher and for mechanical rebrand work.
- Expect to be the in-game tester at each gate: T1 (loads cleanly), T2
  (self-test), T3 (play 1–22). Each should be a short session.
- Before the first session, download the research workbook as .xlsx from its
  page and save it as `docs/research/verified.xlsx`.
- The first in-game sessions are short and high-value: T2 (`/wf selftest` and
  `/wf dump` on your Troll Warrior, including one visit to a Warrior trainer)
  settles rage costs, the disputed talent values, base stats and trainer
  prices in one go.
