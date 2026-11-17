-- Modules/SelfTest.lua
-- Purpose: /wf selftest. Probes which game functions the Forever client
-- offers and whether they return readable values, and saves a plain-data
-- report to WayfinderData.selftest (written to disk at /reload or logout).
-- See docs/PIPELINE.md section P2 and the research "Checks" tab.
-- Rules this file keeps (CLAUDE.md):
--   * No combat logic. Probes never compare, compute on or branch on a value
--     the client may mark "secret" (cooldowns, auras, health). For those only
--     existence is recorded. Values that are recorded first pass through
--     issecretvalue (when the client has it) and are stored as "secret".
--   * Macro probes run only out of combat, are never executed, use
--     placeholder text, and always delete their scratch macro.
--   * The module registers nothing until /wf selftest runs; a run is spread
--     across frames with WF:RunChunked.
-- Licence: CC BY-NC-SA 4.0, Wayfinder contributors
-- Date: 2026-11-17

local _, addon = ...

local WF = addon.WF
if not WF then return end

local MODULE_ID = "selftest"
local BUDGET_MS = 5
local MACRO_NAME = "WFSelfTest"
local MACRO_ICON = "INV_Misc_QuestionMark"
local COMM_PREFIX = "WFSelfTest"
-- Forever's per-character macro slots (CLAUDE.md platform facts) when the
-- client constant is missing.
local FALLBACK_CHARACTER_MACROS = 18
local MAX_TABLE_ENTRIES = 60
local MAX_DEPTH = 6
local MAX_STRING = 300

local SelfTest = {}
WF.SelfTest = SelfTest

local VALID_STATUS = { pass = true, fail = true, missing = true, skipped = true, info = true }

local running -- RunChunked handle while a run is in progress
local scratchFrames = {} -- throwaway frames, created once and kept hidden

-- ---------------------------------------------------------------------------
-- Helpers

-- Look up a dotted global path ("C_Spell.GetSpellInfo") without erroring.
local function resolve(path)
    local value = _G
    for part in path:gmatch("[^%.]+") do
        if type(value) ~= "table" then return nil end
        value = value[part]
    end
    return value
end

local function exists(path)
    return resolve(path) ~= nil
end

-- True only when the client says the value is secret. Never reads the value.
local function isSecret(value)
    local check = resolve("issecretvalue")
    if type(check) ~= "function" then return false end
    local ok, secret = pcall(check, value)
    return ok and secret == true
end

-- Copy a value into plain, serializable data. Secret values become "secret".
local function plain(value, depth)
    if isSecret(value) then return "secret" end
    local kind = type(value)
    if kind == "string" then
        return #value > MAX_STRING and value:sub(1, MAX_STRING) or value
    elseif kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then return tostring(value) end
        return value
    elseif kind == "boolean" or kind == "nil" then
        return value
    elseif kind == "table" then
        depth = depth or 0
        if depth >= MAX_DEPTH then return "<table>" end
        local out, count = {}, 0
        for key, entry in pairs(value) do
            count = count + 1
            if count > MAX_TABLE_ENTRIES then
                out["<truncated>"] = true
                break
            end
            local keyType = type(key)
            local plainKey = (keyType == "string" or keyType == "number") and not isSecret(key) and key
                or tostring(keyType)
            out[plainKey] = plain(entry, depth + 1)
        end
        return out
    end
    return "<" .. kind .. ">"
end

local function round(value, decimals)
    if type(value) ~= "number" or isSecret(value) then return nil end
    return tonumber(("%." .. decimals .. "f"):format(value))
end

local function call(path, ...)
    local fn = resolve(path)
    if type(fn) ~= "function" then return false, "missing" end
    return pcall(fn, ...)
end

local function sortedKeys(t)
    local keys = {}
    if type(t) ~= "table" then return keys end
    for key in pairs(t) do keys[#keys + 1] = tostring(key) end
    table.sort(keys)
    return keys
end

local function scratchFrame(key, frameType, template)
    local frame = scratchFrames[key]
    if not frame then
        frame = CreateFrame(frameType, nil, nil, template)
        scratchFrames[key] = frame
    end
    frame:Hide()
    return frame
end

-- ---------------------------------------------------------------------------
-- Probe list. Each probe returns status, value, detail.

local probes = {}

local function probe(id, group, run)
    probes[#probes + 1] = { id = id, group = group, run = run }
end

-- client --------------------------------------------------------------------

-- Fork loads with Interface 16001 (Checks tab row 2).
probe("client.interface", "client", function()
    local version, build, _, interface = GetBuildInfo()
    local status = type(interface) == "number" and "pass" or "fail"
    return status, { interface = interface, version = version, build = build }
end)

-- WOW_PROJECT_CAMELOT (CLAUDE.md platform facts: reported as 18).
probe("client.project", "client", function()
    local defined = WOW_PROJECT_CAMELOT ~= nil
    local equal = defined and WOW_PROJECT_ID == WOW_PROJECT_CAMELOT
    return equal and "pass" or "fail",
        { projectId = WOW_PROJECT_ID, camelotDefined = defined, camelot = WOW_PROJECT_CAMELOT, equal = equal }
end)

probe("client.race", "client", function()
    local _, raceToken, raceId = UnitRace("player")
    return type(raceToken) == "string" and "pass" or "fail", { token = raceToken, id = raceId }
end)

probe("client.locale", "client", function()
    local locale = GetLocale()
    return type(locale) == "string" and "pass" or "fail", locale
end)

-- Lua's require is renamed import in this client (CLAUDE.md).
probe("client.import", "client", function()
    return "info", { import = type(resolve("import")), require = type(resolve("require")) }
end)

-- api-existence ---------------------------------------------------------------
-- Existence only; nothing is called. Notes name the open question answered.

local API_PATHS = {
    -- C_QuestLog functions the engine calls on the Retail-family path.
    "C_QuestLog.GetInfo", "C_QuestLog.RequestLoadQuestByID", "C_QuestLog.SetSelectedQuest",
    "C_QuestLog.IsComplete", "C_QuestLog.SetAbandonQuest", "C_QuestLog.AbandonQuest",
    "C_QuestLog.GetAllCompletedQuestIDs", "C_QuestLog.IsQuestFlaggedCompleted",
    "C_QuestLog.IsQuestFlaggedCompletedOnAccount", "C_QuestLog.GetTitleForQuestID",
    "C_QuestLog.GetQuestInfo", "C_QuestLog.GetNumQuestLogEntries", "C_QuestLog.GetLogIndexForQuestID",
    "C_QuestLog.IsPushableQuest", "C_QuestLog.IsOnQuest", "C_QuestLog.GetQuestObjectives",
    -- Position (arrow and pins; B4).
    "C_Map.GetBestMapForUnit", "C_Map.GetPlayerMapPosition", "UnitPosition",
    -- Spell and item data (B1, C5).
    "C_Spell.GetSpellInfo", "C_Spell.GetSpellPowerCost", "C_Item.GetItemStats",
    "C_TooltipInfo", "C_TooltipInfo.GetSpellByID", "C_TooltipInfo.GetItemByID",
    "C_TooltipInfo.GetInventoryItem", "C_TooltipInfo.GetHyperlink",
    -- Automation (Checks tab rows 5 and 6).
    "C_GossipInfo.GetOptions", "C_GossipInfo.SelectOption", "AcceptQuest", "CompleteQuest",
    "GetQuestReward", "C_Container.UseContainerItem", "C_MerchantFrame.SellAllJunkItems",
    "SellAllJunkItems", "RepairAllItems",
    -- Macros (Checks tab row 7).
    "CreateMacro", "EditMacro", "DeleteMacro", "GetNumMacros",
    -- Party step-sharing (E3).
    "C_EncodingUtil", "C_EncodingUtil.CompressString", "C_EncodingUtil.DecompressString",
    "C_EncodingUtil.EncodeBase64", "C_EncodingUtil.DecodeBase64",
    -- Menus (E2).
    "EasyMenu", "MenuUtil.CreateContextMenu", "UIDropDownMenu_Initialize", "ToggleDropDownMenu",
    -- Cooldown display and secret values (C6, E3; DESIGN section 5.6).
    "C_Spell.GetSpellCooldownDuration", "C_Secrets", "issecretvalue",
    -- Misc engine dependencies.
    "C_AddOns.IsAddOnLoaded", "C_Timer.NewTicker", "TooltipDataProcessor", "EditModeManagerFrame",
    -- Old globals the wiki does not list for Forever (absence expected).
    "GetSpellPowerCost", "GetItemStats", "GetSpellInfo",
}

local OLD_GLOBALS = { GetSpellPowerCost = true, GetItemStats = true, GetSpellInfo = true }

for _, path in ipairs(API_PATHS) do
    probe("api." .. path, "api-existence", function()
        local value = resolve(path)
        local detail = OLD_GLOBALS[path] and "old global; absence expected" or nil
        if value == nil then return "missing", nil, detail end
        return "pass", type(value), detail
    end)
end

-- position --------------------------------------------------------------------
-- Checks tab row 4 (player position in the open world); B4 (UiMapIDs).

probe("position.unit", "position", function()
    local ok, y, x, _, instance = call("UnitPosition", "player")
    if not ok then return y == "missing" and "missing" or "fail", nil, tostring(y) end
    if isSecret(y) or isSecret(x) then return "info", "secret", "position is marked secret" end
    if type(y) ~= "number" or type(x) ~= "number" then return "fail", nil, "no position (instance?)" end
    return "pass", { y = round(y, 1), x = round(x, 1), instance = plain(instance) }
end)

probe("position.map", "position", function()
    local ok, mapId = call("C_Map.GetBestMapForUnit", "player")
    if not ok then return mapId == "missing" and "missing" or "fail", nil, tostring(mapId) end
    if type(mapId) ~= "number" then return "fail", nil, "no map id" end
    local infoOk, info = call("C_Map.GetMapInfo", mapId)
    local name = infoOk and type(info) == "table" and info.name or nil
    return "pass", { uiMapId = mapId, name = plain(name) }
end)

probe("position.mapPosition", "position", function()
    local mapOk, mapId = call("C_Map.GetBestMapForUnit", "player")
    if not mapOk or type(mapId) ~= "number" then return "skipped", nil, "no map id" end
    local ok, pos = call("C_Map.GetPlayerMapPosition", mapId, "player")
    if not ok then return pos == "missing" and "missing" or "fail", nil, tostring(pos) end
    if pos == nil then return "fail", nil, "nil (instance or restricted)" end
    local x, y = pos:GetXY()
    return "pass", { uiMapId = mapId, x = round(x, 3), y = round(y, 3) }
end)

-- Checks tab row 10: HereBeDragons loads on Forever.
probe("position.hereBeDragons", "position", function()
    local hbd = LibStub and LibStub("HereBeDragons-2.0", true)
    if not hbd then return "missing", nil, "HereBeDragons-2.0 not loaded" end
    local minor = LibStub.minors and LibStub.minors["HereBeDragons-2.0"]
    local x, y, mapId = hbd:GetPlayerZonePosition()
    if type(x) ~= "number" then return "fail", { minor = minor }, "GetPlayerZonePosition returned nil" end
    return "pass", { minor = minor, x = round(x, 3), y = round(y, 3), uiMapId = plain(mapId) }
end)

-- quests ----------------------------------------------------------------------
-- Checks tab row 3: quest-log calls return readable values out of combat.

probe("quests.count", "quests", function()
    local ok, entries, questCount = call("C_QuestLog.GetNumQuestLogEntries")
    if not ok then return entries == "missing" and "missing" or "fail", nil, tostring(entries) end
    if type(entries) ~= "number" then return "fail", plain(entries), "not a number" end
    return "pass", { entries = entries, quests = plain(questCount) }
end)

probe("quests.sample", "quests", function()
    local ok, entries = call("C_QuestLog.GetNumQuestLogEntries")
    if not ok or type(entries) ~= "number" then return "skipped", nil, "no quest count" end
    if type(resolve("C_QuestLog.GetInfo")) ~= "function" then return "missing", nil, "C_QuestLog.GetInfo" end
    local sample, allReadable = {}, true
    for index = 1, entries do
        if #sample >= 3 then break end
        local info = C_QuestLog.GetInfo(index)
        if type(info) == "table" and not info.isHeader and type(info.questID) == "number" then
            local title = info.title
            local readable = type(title) == "string" and title ~= ""
            allReadable = allReadable and readable
            local entry = { questID = info.questID, titleReadable = readable, title = plain(title) }
            local objOk, objectives = call("C_QuestLog.GetQuestObjectives", info.questID)
            if objOk and type(objectives) == "table" then
                local types = {}
                for i, objective in ipairs(objectives) do
                    types[i] = type(objective) == "table" and plain(objective.type) or type(objective)
                end
                entry.objectiveCount = #objectives
                entry.objectiveTypes = types
            else
                entry.objectives = objOk and "not a table" or tostring(objectives)
                allReadable = false
            end
            sample[#sample + 1] = entry
        end
    end
    if #sample == 0 then return "info", sample, "no quests in the log" end
    return allReadable and "pass" or "fail", sample
end)

-- items -------------------------------------------------------------------------
-- C5: item stats readable for gear scoring (Checks tab row 8).

local function itemReport(link)
    local report = { itemId = tonumber(link:match("item:(%d+)")) }
    local ok, stats = call("C_Item.GetItemStats", link)
    if ok and type(stats) == "table" then
        report.statKeys = sortedKeys(stats)
    else
        report.stats = ok and type(stats) or tostring(stats)
    end
    return report, ok and type(stats) == "table"
end

local function tooltipLines(path, ...)
    local ok, data = call(path, ...)
    if ok and type(data) == "table" and type(data.lines) == "table" then return #data.lines end
    return ok and "no lines" or tostring(data)
end

probe("items.mainhand", "items", function()
    local slot = 16
    local slotOk, slotId = call("GetInventorySlotInfo", "MainHandSlot")
    if slotOk and type(slotId) == "number" then slot = slotId end
    local ok, link = call("GetInventoryItemLink", "player", slot)
    if not ok then return link == "missing" and "missing" or "fail", nil, tostring(link) end
    if type(link) ~= "string" then return "skipped", nil, "no main-hand item" end
    local report, statsOk = itemReport(link)
    report.slot = slot
    report.tooltipLines = tooltipLines("C_TooltipInfo.GetInventoryItem", "player", slot)
    return (statsOk and report.itemId) and "pass" or "fail", report
end)

probe("items.bag", "items", function()
    if type(resolve("C_Container.GetContainerItemLink")) ~= "function" then
        return "missing", nil, "C_Container.GetContainerItemLink"
    end
    for bag = 0, 4 do
        local slotsOk, slots = call("C_Container.GetContainerNumSlots", bag)
        if slotsOk and type(slots) == "number" then
            for slot = 1, slots do
                local link = C_Container.GetContainerItemLink(bag, slot)
                if type(link) == "string" then
                    local report, statsOk = itemReport(link)
                    report.bag, report.slot = bag, slot
                    report.tooltipLines = tooltipLines("C_TooltipInfo.GetBagItem", bag, slot)
                    return (statsOk and report.itemId) and "pass" or "fail", report
                end
            end
        end
    end
    return "skipped", nil, "bags are empty"
end)

-- spells ------------------------------------------------------------------------
-- B1: power cost per ability rank. Power cost is tooltip data, not combat
-- state; any field the client marks secret is stored as "secret".

local function spellbookSample(limit)
    local found = {}
    local getInfo = resolve("C_SpellBook.GetSpellBookItemInfo")
    local bank = resolve("Enum.SpellBookSpellBank.Player")
    if type(getInfo) == "function" and bank ~= nil then
        local spellType = resolve("Enum.SpellBookItemType.Spell")
        for index = 1, 500 do
            local info = getInfo(index, bank)
            if type(info) ~= "table" then break end
            if (spellType == nil or info.itemType == spellType) and type(info.spellID) == "number"
                    and not info.isPassive then
                found[#found + 1] = { id = info.spellID, name = info.name }
                if #found >= limit then break end
            end
        end
        return "C_SpellBook", found
    end
    local oldInfo = resolve("GetSpellBookItemInfo")
    if type(oldInfo) == "function" then
        local bookType = resolve("BOOKTYPE_SPELL") or "spell"
        for index = 1, 500 do
            local kind, spellId = oldInfo(index, bookType)
            if kind == nil then break end
            if kind == "SPELL" and type(spellId) == "number" then
                found[#found + 1] = { id = spellId }
                if #found >= limit then break end
            end
        end
        return "GetSpellBookItemInfo", found
    end
    return nil, found
end

probe("spells.sample", "spells", function()
    local api, spells = spellbookSample(3)
    if not api then return "missing", nil, "no spellbook API (C_SpellBook, GetSpellBookItemInfo)" end
    if #spells == 0 then return "fail", { api = api }, "no spells found" end
    local out, allOk = {}, true
    for i, spell in ipairs(spells) do
        local entry = { id = spell.id, name = plain(spell.name) }
        if entry.name == nil then
            local infoOk, info = call("C_Spell.GetSpellInfo", spell.id)
            entry.name = infoOk and type(info) == "table" and plain(info.name) or nil
        end
        local ok, costs = call("C_Spell.GetSpellPowerCost", spell.id)
        if ok and type(costs) == "table" then
            entry.costs = {}
            for n, cost in ipairs(costs) do
                if type(cost) == "table" then
                    entry.costs[n] = { type = plain(cost.type), name = plain(cost.name), cost = plain(cost.cost) }
                end
            end
        elseif ok then
            entry.costs = "none" -- nil for a spell without a cost
        else
            entry.costs = tostring(costs)
            allOk = false
        end
        out[i] = entry
    end
    return allOk and "pass" or "fail", { api = api, spells = out }
end)

-- macros ------------------------------------------------------------------------
-- Checks tab row 7 (macro creation, slot and length limits) and B12/C3 (macro
-- command support). Out of combat only; macros are stored, read back and
-- deleted, never executed.

local MACRO_FUNCTIONS = { "CreateMacro", "EditMacro", "DeleteMacro", "GetMacroInfo", "GetMacroIndexByName",
    "GetNumMacros" }

local function deleteScratchMacro()
    for _ = 1, 5 do
        local index = GetMacroIndexByName(MACRO_NAME)
        if type(index) ~= "number" or index == 0 then return end
        DeleteMacro(index)
    end
end

local function macroBlocker()
    if InCombatLockdown() then return "skipped", nil, "in combat" end
    for _, name in ipairs(MACRO_FUNCTIONS) do
        if type(resolve(name)) ~= "function" then return "missing", nil, name end
    end
    return nil
end

local function freeCharacterSlot()
    pcall(deleteScratchMacro)
    local _, perCharacter = GetNumMacros()
    local max = tonumber(resolve("MAX_CHARACTER_MACROS")) or FALLBACK_CHARACTER_MACROS
    return type(perCharacter) == "number" and perCharacter < max
end

local function readScratchBody()
    local index = GetMacroIndexByName(MACRO_NAME)
    if type(index) ~= "number" or index == 0 then return nil end
    local _, _, body = GetMacroInfo(index)
    return body
end

-- Store body in the scratch macro, read it back, and always delete it.
local function storeAndReadBack(body)
    local ok, stored = pcall(function()
        local index = CreateMacro(MACRO_NAME, MACRO_ICON, body, true)
        if type(index) ~= "number" or index == 0 then error("CreateMacro returned " .. tostring(index), 0) end
        return readScratchBody()
    end)
    pcall(deleteScratchMacro)
    if not ok then error(stored, 0) end
    return stored
end

probe("macros.counts", "macros", function()
    local status, value, detail = macroBlocker()
    if status then return status, value, detail end
    local account, perCharacter = GetNumMacros()
    return type(account) == "number" and "pass" or "fail", {
        account = plain(account),
        character = plain(perCharacter),
        maxAccount = plain(resolve("MAX_ACCOUNT_MACROS")),
        maxCharacter = plain(resolve("MAX_CHARACTER_MACROS")),
    }
end)

probe("macros.roundtrip", "macros", function()
    local status, value, detail = macroBlocker()
    if status then return status, value, detail end
    if not freeCharacterSlot() then return "skipped", nil, "no free character macro slot" end
    local first, second = "/say one", "/say two"
    local result = { created = false, readBack = false, edited = false, deleted = false }
    local ok, err = pcall(function()
        local index = CreateMacro(MACRO_NAME, MACRO_ICON, first, true)
        result.created = type(index) == "number" and index > 0
        if not result.created then error("CreateMacro returned " .. tostring(index), 0) end
        result.readBack = readScratchBody() == first
        EditMacro(GetMacroIndexByName(MACRO_NAME), nil, nil, second)
        result.edited = readScratchBody() == second
    end)
    pcall(deleteScratchMacro)
    result.deleted = GetMacroIndexByName(MACRO_NAME) == 0
    local passed = ok and result.created and result.readBack and result.edited and result.deleted
    return passed and "pass" or "fail", result, not ok and tostring(err) or nil
end)

-- Bodies use placeholder text only; they are never executed.
local MACRO_BODIES = {
    { id = "showtooltip", body = "#showtooltip\n/cast Attack" },
    { id = "castsequence", body = "/castsequence reset=target Attack, Attack" },
    { id = "equipslot", body = "/equipslot 16 Attack" },
    { id = "stance", body = "/cast [stance:2] Attack" },
    { id = "modifiers", body = "/cast [mod:shift,@mouseover,exists] Attack" },
}

for _, entry in ipairs(MACRO_BODIES) do
    probe("macros.body." .. entry.id, "macros", function()
        local status, value, detail = macroBlocker()
        if status then return status, value, detail end
        if not freeCharacterSlot() then return "skipped", nil, "no free character macro slot" end
        local stored = storeAndReadBack(entry.body)
        local verbatim = stored == entry.body
        return verbatim and "pass" or "fail",
            { verbatim = verbatim, length = type(stored) == "string" and #stored or nil },
            not verbatim and plain(stored) or nil
    end)
end

-- Length limit (CLAUDE.md: 255 characters). 256 is expected to be cut or refused.
for _, length in ipairs({ 255, 256 }) do
    probe("macros.length." .. length, "macros", function()
        local status, value, detail = macroBlocker()
        if status then return status, value, detail end
        if not freeCharacterSlot() then return "skipped", nil, "no free character macro slot" end
        local body = "/say " .. ("a"):rep(length - 5)
        local ok, stored = pcall(storeAndReadBack, body)
        if not ok then
            return length == 255 and "fail" or "info", { accepted = false }, tostring(stored)
        end
        local storedLength = type(stored) == "string" and #stored or nil
        local verbatim = stored == body
        if length == 255 then return verbatim and "pass" or "fail", { stored = storedLength, verbatim = verbatim } end
        return "info", { accepted = true, stored = storedLength, verbatim = verbatim }
    end)
end

-- secure --------------------------------------------------------------------------
-- Protected actions go through secure templates (CLAUDE.md).

probe("secure.actionButton", "secure", function()
    if InCombatLockdown() then return "skipped", nil, "in combat" end
    local button = scratchFrame("secureButton", "Button", "SecureActionButtonTemplate")
    return button and "pass" or "fail", { created = button ~= nil }
end)

-- cooldown-display ------------------------------------------------------------------
-- C6, E3, DESIGN section 5.6. Existence only: no cooldown is fetched or inspected.

probe("cooldown.getDuration", "cooldown-display", function()
    return exists("C_Spell.GetSpellCooldownDuration") and "pass" or "missing"
end)

probe("cooldown.frameMethod", "cooldown-display", function()
    local frame = scratchFrame("cooldown", "Cooldown")
    local found = type(frame.SetCooldownFromDurationObject) == "function"
    return found and "pass" or "missing", { SetCooldownFromDurationObject = found }
end)

probe("cooldown.statusBarMethod", "cooldown-display", function()
    local bar = scratchFrame("statusBar", "StatusBar")
    local found = type(bar.SetTimerDuration) == "function"
    return found and "pass" or "missing", { SetTimerDuration = found }
end)

probe("cooldown.editMode", "cooldown-display", function()
    local manager = resolve("EditModeManagerFrame")
    local register = type(manager) == "table" and type(manager.RegisterSystemFrame) == "function"
    local value = {
        manager = manager ~= nil,
        registerSystemFrame = register,
        cEditMode = exists("C_EditMode"),
    }
    return (manager and register) and "pass" or "missing", value
end)

-- modules ---------------------------------------------------------------------------
-- C2 and Checks tab row 11: are upstream's ItemUpgrades and Talents active?

probe("modules.itemUpgrades", "modules", function()
    return "info", { present = addon.itemUpgrades ~= nil }
end)

probe("modules.talents", "modules", function()
    local talents = addon.talents
    local value = { present = talents ~= nil }
    if talents and type(talents.IsSupported) == "function" then
        local ok, supported = pcall(talents.IsSupported, talents)
        value.supported = ok and (supported and true or false) or tostring(supported)
    end
    return "info", value
end)

probe("modules.wayfinder", "modules", function()
    local list = {}
    for _, id in ipairs(WF.GetModuleIds()) do
        list[#list + 1] = { id = id, enabled = WF:IsEnabled(id), toggle = WF:GetToggle(id) }
    end
    return "info", { development = WF.isDevelopment, version = WF.version, modules = list }
end)

-- comm ------------------------------------------------------------------------------
-- Addon message prefixes can be registered; nothing is sent.

probe("comm.registerPrefix", "comm", function()
    local ok, result = call("C_ChatInfo.RegisterAddonMessagePrefix", COMM_PREFIX)
    if not ok then return result == "missing" and "missing" or "fail", nil, tostring(result) end
    return "pass", { result = plain(result) }
end)

SelfTest.probes = probes

-- ---------------------------------------------------------------------------
-- Run

local function runProbe(entry)
    local ok, status, value, detail = pcall(entry.run)
    if not ok then
        return { id = entry.id, group = entry.group, status = "fail", detail = tostring(status) }
    end
    if not VALID_STATUS[status] then
        return { id = entry.id, group = entry.group, status = "fail", detail = "probe returned no valid status" }
    end
    return { id = entry.id, group = entry.group, status = status, value = plain(value), detail = plain(detail) }
end

local function safe(fn)
    local ok, value = pcall(fn)
    if ok then return value end
    return nil
end

local function header()
    local report = { version = WF.version, development = WF.isDevelopment }
    local version, build, buildDate, interface = GetBuildInfo()
    report.build = plain({ version = version, build = build, date = buildDate, interface = interface })
    report.interface = plain(interface)
    report.projectId = plain(WOW_PROJECT_ID)
    report.locale = plain(safe(GetLocale))
    report.time = {
        date = safe(function() return date("%Y-%m-%d %H:%M:%S") end),
        server = plain(safe(function() return GetServerTime() end)),
    }
    local character = {}
    pcall(function()
        local _, classToken, classId = UnitClass("player")
        local raceToken, raceId = select(2, UnitRace("player"))
        character.class, character.classId = classToken, classId
        character.race, character.raceId = raceToken, raceId
        character.level = UnitLevel("player")
        character.faction = UnitFactionGroup("player")
    end)
    report.character = plain(character)
    return report
end

local function summarize(results)
    local counts = { pass = 0, fail = 0, missing = 0, skipped = 0, info = 0 }
    for _, result in ipairs(results) do
        counts[result.status] = (counts[result.status] or 0) + 1
    end
    return counts
end

local function finish(status, report)
    running = nil
    report.complete = status == "done"
    report.counts = summarize(report.results)
    if WF.db then WF.db.selftest = report end
    local c = report.counts
    local line = ("self-test %s: %d passed, %d failed, %d missing, %d skipped - /reload to save"):format(
        report.complete and "done" or "stopped early", c.pass, c.fail, c.missing, c.skipped)
    WF.Print(line)
end

--- Start a self-test run. Returns false if one is already running.
function SelfTest.Run()
    if running then
        WF.Print("self-test is already running.")
        return false
    end
    local ok, report = pcall(header)
    if not ok then report = { headerError = tostring(report) } end
    report.results = {}
    local steps = {}
    for i, entry in ipairs(probes) do
        steps[i] = function()
            report.results[#report.results + 1] = runProbe(entry)
        end
    end
    WF.Print(("self-test started (%d probes)."):format(#probes))
    running = WF:RunChunked(steps, function(status) finish(status, report) end, BUDGET_MS, MODULE_ID)
    return true
end

function SelfTest.IsRunning()
    return running ~= nil
end

WF:RegisterModule(MODULE_ID, {
    title = "Self-test",
    desc = "Adds /wf selftest: checks which game functions this client offers and saves the results "
        .. "(WayfinderData) for the developers. Nothing runs until you type the command.",
    default = false,
    devDefault = true,
    OnEnable = function() end,
    OnDisable = function()
        if running then running.Cancel() end
        for _, frame in pairs(scratchFrames) do frame:Hide() end
    end,
    slash = {
        selftest = function() SelfTest.Run() end,
    },
})
