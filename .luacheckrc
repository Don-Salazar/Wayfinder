-- luacheck configuration for Wayfinder (fork of RestedXP/RXPGuides).
-- Run from the repo root:  luacheck .
--
-- Two policies:
--   * Upstream code (everything inherited from RXPGuides): we do not own it
--     and do not edit it in P0. It is still parsed, so a syntax error fails
--     the run, but every warning is suppressed: `ignore = { "." }` matches
--     every warning code, while errors (E0xx, e.g. E011 syntax error) cannot
--     be ignored. Verified 2026-11-16 with a deliberately broken temp file in
--     DB/: luacheck reported E011 and exited 2.
--   * Our code (Modules/, Data/, Guides/wf/, tests/): strict, zero warnings.
--     Globals must be declared here. Extend the WoW API list as needed, one
--     name at a time, only for functions the code really calls.
--
-- Note: luacheck parses newer-Lua syntax (goto, //, bit ops) without
-- complaint. The real Lua 5.1 compile check lives in
-- tests/spec/lua51_compile_spec.lua.

std = "wf_lua51+wow"
max_line_length = 120
codes = true

exclude_files = {
  ".tools/**",
  "node_modules/**",
  ".git/**",
  -- Built addon (tools/build-addon): a renamed copy of files linted at their
  -- source; CI syntax-checks it with luac -p (Lua 5.1) instead.
  "dist/**",
  -- CI only: leafo/gh-actions-lua installs Lua into ".lua/" and
  -- leafo/gh-actions-luarocks installs LuaRocks (prefix, so also the rocks
  -- `luarocks install` adds: luacheck, busted and their deps) into
  -- ".luarocks/", both inside the workspace (their READMEs/main.js, read
  -- 2026-11-17). Without these, `luacheck .` lints third-party rocks under
  -- the strict policy and fails.
  ".lua/**",
  ".luarocks/**",
}

-- Lua 5.1 as WoW exposes it: no io, os, require/dofile/loadfile, package,
-- module or debug. (Forever renames `require` to `import`.)
stds.wf_lua51 = {
  read_globals = {
    "_G", "_VERSION", "assert", "collectgarbage", "error", "getfenv",
    "getmetatable", "ipairs", "load", "loadstring", "next", "pairs", "pcall",
    "print", "rawequal", "rawget", "rawset", "select", "setfenv",
    "setmetatable", "tonumber", "tostring", "type", "unpack", "xpcall",
    "coroutine", "math", "string", "table",
    -- WoW's global aliases for string/table/math helpers.
    "bit", "strsplit", "strjoin", "strtrim", "strlen", "strsub", "strfind",
    "strmatch", "strlower", "strupper", "strrep", "gsub", "format",
    "tinsert", "tremove", "wipe", "sort", "floor", "ceil", "abs", "max", "min",
    "date", "time", "difftime", "debugstack",
  },
}

-- WoW API surface our code may read. Seeded with what CLAUDE.md lists as
-- available on Forever plus frame/event basics. Add names as code needs them.
local wow_read_globals = {
  "CreateFrame", "UIParent", "C_Timer", "GetTime", "GetBuildInfo",
  "WOW_PROJECT_ID", "WOW_PROJECT_CAMELOT",
  "InCombatLockdown", "hooksecurefunc", "issecurevariable",
  "LibStub",
  "C_AddOns", "C_Map", "C_QuestLog", "C_Spell", "C_Item", "C_TooltipInfo",
  "UnitLevel", "UnitClass", "UnitRace", "UnitFactionGroup", "UnitName",
  "UnitGUID", "GetRealmName", "GetLocale",
  "CreateMacro", "EditMacro", "DeleteMacro", "GetMacroInfo",
  "GetMacroIndexByName", "GetNumMacros", "MAX_ACCOUNT_MACROS",
  "MAX_CHARACTER_MACROS",
  "Settings", "SlashCmdList",
  -- Modules/MinimapButton.lua
  "Minimap", "GameTooltip", "GetCursorPosition",
  -- Modules/MenuCompat.lua (read through _G and feature-detected; any may be nil)
  "Menu", "MenuUtil", "MenuResponse", "EasyMenu", "CloseDropDownMenus",
  "UIDropDownMenu_Initialize", "UIDropDownMenu_AddButton", "ToggleDropDownMenu",
  -- Modules/Core.lua
  "GetAddOnMetadata", "DEFAULT_CHAT_FRAME", "geterrorhandler", "debugprofilestop",
  -- Modules/SelfTest.lua (most probes look names up dynamically through _G)
  "C_Container", "GetServerTime",
}
stds.wow = { read_globals = wow_read_globals }

-- ---------------------------------------------------------------------------
-- Upstream code: parse only. Listed explicitly (not "everything") so a new
-- top-level directory of ours defaults to the strict policy above.
local upstream_only = { ignore = { "." } }
files["*.lua"]         = upstream_only -- root engine files
files["DB/**"]         = upstream_only
files["Guides/**"]     = upstream_only
files["lang/**"]       = upstream_only
files["libs/**"]       = upstream_only
files["locale/**"]     = upstream_only
files["UI/**"]         = upstream_only
files["Scripts/**"]    = upstream_only

-- ---------------------------------------------------------------------------
-- Our code: strict. Guides/wf/ sits inside upstream's Guides/ and must win
-- over the Guides/** section above; luacheck applies more specific path
-- sections after less specific ones.
files["Guides/wf/**"] = { enable = { "." } }

-- Our saved variables (declared in Wayfinder.toc through tools/build-toc).
-- Only the core module assigns them; other files reach them through addon.WF.
files["Modules/Core.lua"] = { globals = { "WayfinderData", "WayfinderCharData" } }

-- Busted specs, spec support and the WoW API stub. Full Lua 5.1 (io, os,
-- debug are fine here: tests run outside the client). The stub sets its
-- globals with rawset, so specs only ever *read* WoW globals.
files["tests/**"] = {
  std = "lua51+busted+wow",
}
