# NOTICE

Wayfinder (working name) is a free addon for World of Warcraft: Forever. It
is an adaptation of **RestedXP Guides (RXPGuides)**.

## Upstream work

| | |
|---|---|
| Work | RestedXP Guides (RXPGuides) |
| Source | https://github.com/RestedXP/RXPGuides |
| Author | RestedXP and the RXPGuides contributors (see the upstream commit history) |
| Licence | Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0), https://creativecommons.org/licenses/by-nc-sa/4.0/ |
| Forked at | Upstream commit `22e6ce26e2855ec730d50d40f8a7d5cd733a7327` (2026-11-14) |

## Licence of this adaptation

This adaptation is licensed under CC BY-NC-SA 4.0, the same licence as the
upstream work. The full text is in `LICENSE`. The addon is free and stays
free: no paid content, no premium tier, no advertising.

## Changes

Files in this repository have been changed from the upstream work.
`docs/UPSTREAM.md` records the upstream commit the fork is based on. The git
history shows every change.

State on 2026-11-16:

- Upstream addon code and data are unmodified.
- `.gitignore` has a block of lines added at the end.
- Added files, none of which come from upstream: `NOTICE.md`, `CLAUDE.md`,
  `HANDOFF_README.md`, `KICKOFF_PROMPT.md`, `docs/`, `tools/`, `tests/`,
  `package.json`, `package-lock.json`, `tsconfig.json`, `.luacheckrc`,
  `.busted`, `.github/workflows/ci.yml`.

From here on, lines changed inside upstream files carry a `-- WF:` comment,
and new code lives in new files.

## No endorsement

This project is not affiliated with, sponsored by or endorsed by RestedXP,
RXP MEDIA LLC or Blizzard Entertainment. "RestedXP" and "RXP" are names of
the upstream project and are used here only to give credit. World of
Warcraft is a trademark of Blizzard Entertainment, Inc.

## Third-party components

These components came with the upstream work. Each keeps its own licence.

| Component | Path | Licence | Notes |
|---|---|---|---|
| Ace3 (AceAddon, AceComm, AceConfig, AceConsole, AceDB, AceDBOptions, AceEvent, AceGUI, AceLocale, AceSerializer) and CallbackHandler-1.0 | `libs/` | Ace3 BSD-style licence, text below | |
| LibCandyBar-3.0 | `libs/` | Ace3-style BSD, as published on WowAce | |
| LibDBIcon-1.0 | `libs/` | Ace3-style BSD, as published on WowAce | |
| HereBeDragons | `libs/HereBeDragons/` | BSD (`## X-License: BSD` in its TOC). Author: Nevcairiel | |
| LibStub | `libs/` | Public domain | |
| ChatThrottleLib | inside AceComm | Public domain | |
| plc `base64.lua` | `libs/plc/` | MIT, © 2015–2018 Phil Leblanc. Licence text in `libs/plc/LICENSE` | Modified by upstream |
| LibDeflate | `libs/LibDeflate/` | zlib licence per the file header, © Haoqian He | The bundled `LICENSE.txt` is an older LGPLv3 text. Under review |
| LibDataBroker-1.1 | `libs/` | No licence statement found | Under review |
| LibUIDropDownMenu | `libs/mainline/` | GPL, as published on WowAce | Marked for removal |
| Cpt. Stadics' Vendor Treasures (data) | `CptStadicsVendorTreasures.lua` | CC BY-NC 3.0, https://creativecommons.org/licenses/by-nc/3.0/. Author: Stadics. Source: https://www.curseforge.com/wow/addons/cpt-stadics-map-of-vendor-treasures | Adapted by upstream. Under review |
| HandyNotes – Pandaria Treasures (data) | `DB/mop/rares.lua` | GPLv3, as published on CurseForge | Not loaded on Forever. Marked for removal |

"Under review" and "Marked for removal" are tracked in
`docs/OPEN_QUESTIONS.md` § D1.

### Ace3 licence

```
Copyright (c) 2007, Ace3 Development Team

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Redistribution of a stand alone version is strictly prohibited without
      prior written authorization from the Lead of the Ace3 Development Team.
    * Neither the name of the Ace3 Development Team nor the names of its contributors
      may be used to endorse or promote products derived from this software without
      specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
