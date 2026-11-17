# UPSTREAM.md — which upstream commit we are based on

Upstream: https://github.com/RestedXP/RXPGuides (remote `upstream`, default
branch `main`). Licence: CC BY-NC-SA 4.0 (`LICENSE`).

## Current base

| Field | Value |
|---|---|
| Upstream commit | `22e6ce26e2855ec730d50d40f8a7d5cd733a7327` |
| Commit date | 2026-11-14 23:17:14 -0300 |
| Commit subject | Added forever FP data |
| Recorded | 2026-11-16 |
| How we got it | Fork point of `Don-Salazar/Wayfinder`; `upstream/main` pointed at the same commit when fetched on 2026-11-16 |

`tools/check-origins` reads the same commit hash from
`tools/check-origins/origins.json` to decide which files came from upstream.
Change both together.

## Sync log

| Date | Action | Upstream commit | Notes |
|---|---|---|---|
| 2026-11-16 | Fork cloned, `upstream` remote added | `22e6ce26` | No engine changes yet |

## How to sync (weekly, DESIGN § 3)

1. `git fetch upstream`
2. Merge or rebase `upstream/main` into `main`.
3. If engine files conflict, stop and ask Don (CLAUDE.md, working agreements).
4. Update the table above and `tools/check-origins/origins.json`.
5. Re-run lint, tests, manifest and origin checks.
