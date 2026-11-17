-- Modules/DataDump.lua
-- Purpose: /wf dump. Reads static game data from the client and saves it as
-- plain data in WayfinderData.dump (written to disk at /reload or logout), so
-- the research numbers can be checked against what the game itself says.
-- See docs/PIPELINE.md section P2 "Data dump" and tools/dump-to-research.
--   /wf dump              full dump (stats, spells, racials, talents, quests,
--                         items, current zone); trainer and maps rows are kept
--   /wf dump <section>    one section: stats spells racials talents quests
--                         items trainer maps
--   /wf dump status       what is saved, and whether a dump is running
--   /wf dump clear        delete the saved dump
-- While the module is on it also records, from events only:
--   * maps: one row per (UiMapID, zone text, subzone text) on zone changes;
--   * trainer: every service listed in an open trainer window (TRAINER_SHOW).
-- Rules this file keeps (CLAUDE.md; owner's rule "no health, no aura effects"):
--   * Static data only: spell costs, tooltips, item stats, trainer lists,
--     talent layout, quest log, BASE stats. Nothing about health, auras or
--     aura-modified values, cooldown state, enemies or combat is read.
--   * Every value the client may mark "secret" passes the issecretvalue check
--     (when the client has it) before anything else touches it, and is stored
--     as the string "secret". Secret values are never compared, computed on,
--     concatenated, formatted, used as keys or tested. Where a link or a flag
--     is expected, "secret" counts as no value.
--   * Every API is looked up by name at run time and called under pcall; a
--     missing API gives the section status "missing", never an error.
--   * No game data in this file: every ID and name comes from the client.
--     Optional development seeds (addon.WF.dumpSeeds, written into dist/ by
--     tools/dump-seeds, never committed) only say which extra IDs to read.
--   * Privacy: no character name, realm or guild is read; tooltip lines wholly
--     in angle brackets ("<Made by ...>") can name another player and are
--     dropped (counted per section). Class, race, level and faction tokens are
--     recorded.
--   * The player's quest log selection is changed only when it can be read
--     first, and is restored however the run ends.
--   * Off: no frames, no events. On and idle: one frame registered for the
--     zone and trainer events only. Work runs across frames (WF:RunChunked).
-- Licence: CC BY-NC-SA 4.0, Wayfinder contributors
-- Date: 2026-11-17

local _, addon = ...

local WF = addon.WF
if not WF then return end

local MODULE_ID = "dump"
local BUDGET_MS = 5
local PROGRESS_SECONDS = 3
local SEED_WAIT_SECONDS = 3

-- Caps (defensive; a hit cap is recorded as capped = true on the section or entry).
local MAX_STRING = 500
local MAX_TOOLTIP_LINES = 40
local MAX_TABLE_ENTRIES = 80
local MAX_DEPTH = 4
local MAX_RAW_RETURNS = 12
local MAX_SPELLBOOK_SLOTS = 1500
local MAX_SEEDS = 2000
local MAX_TALENT_TABS = 5
local MAX_TALENTS_PER_TAB = 60
local MAX_PREREQS = 6
local MAX_QUESTS = 60
local MAX_OBJECTIVES = 20
local MAX_REWARDS = 10
local MAX_COSTS = 10
local MAX_TRAINER_SERVICES = 400
local MAX_TRAINER_RECORDS = 100
local MAX_MAP_ROWS = 2000

-- Container and inventory slot ranges of the client UI (backpack plus four
-- bags; the nineteen equipment slots).
local BAG_FIRST, BAG_LAST = 0, 4
local EQUIP_FIRST, EQUIP_LAST = 1, 19
local PRIMARY_STATS = 5
local TRAINER_FILTERS = { "available", "unavailable", "used" }
local ZONE_EVENTS = { "ZONE_CHANGED_NEW_AREA", "ZONE_CHANGED", "ZONE_CHANGED_INDOORS", "PLAYER_ENTERING_WORLD" }
local SECTIONS = { "stats", "spells", "racials", "talents", "quests", "items", "trainer", "maps" }
-- Sections that build up across runs: never cleared by a dump.
local ACCUMULATING = { trainer = true, maps = true }

local DataDump = {}
WF.DataDump = DataDump

-- Entry caps per section (spellbook plus seeds; equipped, bags plus seeds).
-- A table so specs can lower them.
DataDump.caps = { spells = 2500, items = 600 }

local frame -- event frame, created on first enable
local jobs = {} -- slot ("main" or "trainer") -> running job
local mapIndex -- key -> maps row, rebuilt from saved rows on first use
local trainerOpen = false
local scanner -- hidden scanning tooltip, created only when C_TooltipInfo gives nothing

-- ---------------------------------------------------------------------------
-- Helpers (the same secret-safe pattern as Modules/SelfTest.lua)

local function resolve(path)
    local value = _G
    for part in path:gmatch("[^%.]+") do
        if type(value) ~= "table" then return nil end
        value = value[part]
    end
    return value
end

local function has(path)
    return type(resolve(path)) == "function"
end

-- True only when the client says the value is secret. Never reads the value.
local function isSecret(value)
    local check = resolve("issecretvalue")
    if type(check) ~= "function" then return false end
    local ok, secret = pcall(check, value)
    return ok and secret == true
end

local function pack(...)
    return { n = select("#", ...), ... }
end

-- Cut a string to at most max bytes without splitting a UTF-8 character.
local function utf8Cut(text, max)
    if #text <= max then return text end
    local cut = max
    while cut > 0 do
        local nextByte = text:byte(cut + 1)
        if not nextByte or nextByte < 0x80 or nextByte > 0xBF then break end
        cut = cut - 1
    end
    return text:sub(1, cut)
end

-- A scalar as plain data: "secret", a capped string, a finite number, a
-- boolean, or nil (tables, functions and userdata become nil).
local function scalar(value)
    if isSecret(value) then return "secret" end
    local kind = type(value)
    if kind == "string" then
        return utf8Cut(value, MAX_STRING)
    elseif kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then return tostring(value) end
        return value
    elseif kind == "boolean" then
        return value
    end
    return nil
end

-- Like scalar, but "secret" counts as no value (for links and flags).
local function known(value)
    local v = scalar(value)
    if v == "secret" then return nil end
    return v
end

-- Any value as plain data (tables copied with capped size and depth).
local function plain(value, depth)
    if isSecret(value) then return "secret" end
    if type(value) ~= "table" then return scalar(value) end
    depth = depth or 0
    if depth >= MAX_DEPTH then return "<table>" end
    local out, count = {}, 0
    for key, entry in pairs(value) do
        count = count + 1
        if count > MAX_TABLE_ENTRIES then
            out["<truncated>"] = true
            break
        end
        if not isSecret(key) then
            local keyType = type(key)
            if keyType == "string" or keyType == "number" then out[key] = plain(entry, depth + 1) end
        end
    end
    return out
end

-- pcall a global function by dotted path. Returns ok, results...; a missing
-- function gives false, "missing".
local function call(path, ...)
    local fn = resolve(path)
    if type(fn) ~= "function" then return false, "missing" end
    return pcall(fn, ...)
end

-- call() with every return packed: { n = count, ok, results... }.
local function callPacked(path, ...)
    return pack(call(path, ...))
end

-- Returns from..t.n of a packed table as a plain array (shapes vary by client).
local function rawReturns(t, from)
    local out = {}
    local last = math.min(t.n, from + MAX_RAW_RETURNS - 1)
    for i = from, last do
        local value = scalar(t[i])
        out[#out + 1] = value == nil and "nil" or value
    end
    return out
end

local function first(path, ...)
    local ok, value = call(path, ...)
    if not ok then return nil end
    return scalar(value)
end

-- A link-like string result, or nil (also for "secret").
local function firstLink(path, ...)
    local ok, value = call(path, ...)
    if not ok then return nil end
    value = known(value)
    return type(value) == "string" and value or nil
end

local function now()
    return type(GetTime) == "function" and GetTime() or 0
end

local function round(value, decimals)
    if type(value) ~= "number" then return value end
    local scale = 10 ^ decimals
    return math.floor(value * scale + 0.5) / scale
end

local function dateString()
    local ok, text = pcall(date, "%Y-%m-%d %H:%M:%S")
    return ok and type(text) == "string" and text or nil
end

-- Item ID and name from an item link (plain strings only).
local function linkItemId(link)
    if type(link) ~= "string" then return nil end
    return tonumber(link:match("item:(%d+)"))
end

local function linkName(link)
    if type(link) ~= "string" then return nil end
    return link:match("|h%[(.-)%]|h")
end

--- Creature ID from a unit GUID "Creature-0-<server>-<instance>-<zone>-<ID>-<spawn>"
--- (also Vehicle-...). The other segments are obfuscated on Forever and may be
--- any text; only the sixth field is read and returned. Nil for anything else.
function DataDump.ParseCreatureId(guid)
    if isSecret(guid) or type(guid) ~= "string" then return nil end
    local fields, count = {}, 0
    for part in (guid .. "-"):gmatch("([^-]*)-") do
        count = count + 1
        if count > 7 then return nil end
        if part == "" then return nil end
        fields[count] = part
    end
    if count ~= 7 then return nil end
    if fields[1] ~= "Creature" and fields[1] ~= "Vehicle" then return nil end
    if not fields[6]:find("^%d+$") then return nil end
    return tonumber(fields[6])
end

-- ---------------------------------------------------------------------------
-- Tooltips

-- A line wholly in angle brackets ("<Made by Name>", "<Gift from Name>") can
-- name another player.
local function namesSomeone(text)
    return type(text) == "string" and text:find("^<.+>$") ~= nil
end

local function dropPrivate(lines)
    local kept, dropped = {}, 0
    for _, line in ipairs(lines) do
        if namesSomeone(line.l) or namesSomeone(line.r) then
            dropped = dropped + 1
        else
            kept[#kept + 1] = line
        end
    end
    return kept, dropped
end

local function tooltipFromData(data)
    if isSecret(data) or type(data) ~= "table" then return nil end
    local lines = data.lines
    if isSecret(lines) or type(lines) ~= "table" then return nil end
    local out, capped = {}, nil
    for i, line in ipairs(lines) do
        if i > MAX_TOOLTIP_LINES then
            capped = true
            break
        end
        local left, right
        if not isSecret(line) and type(line) == "table" then
            left, right = scalar(line.leftText), scalar(line.rightText)
            -- Older tooltip data keeps the text in line.args.
            local args = line.args
            if left == nil and not isSecret(args) and type(args) == "table" then
                for _, arg in ipairs(args) do
                    if not isSecret(arg) and type(arg) == "table" then
                        local field = known(arg.field)
                        if field == "leftText" then left = scalar(arg.stringVal) end
                        if field == "rightText" then right = scalar(arg.stringVal) end
                    end
                end
            end
        end
        out[#out + 1] = { l = left, r = right }
    end
    return out, capped
end

local function regionText(region)
    local okType, isText = pcall(function() return region:IsObjectType("FontString") end)
    if not (okType and isText) then return nil end
    local okText, text = pcall(function() return region:GetText() end)
    if not okText then return nil end
    text = scalar(text)
    if text == nil or text == "" then return nil end
    local okJustify, justify = pcall(function() return region:GetJustifyH() end)
    return text, okJustify and known(justify) == "RIGHT"
end

-- Upstream's way (ItemUpgrades.lua): a hidden GameTooltip, SetHyperlink, then
-- read the font strings. A right-justified font string is the right text of
-- the line before it.
local function scanTooltip(link)
    if type(link) ~= "string" then return nil end
    if not scanner then
        local ok, tip = pcall(CreateFrame, "GameTooltip", nil, nil, "GameTooltipTemplate")
        if not ok or not tip then return nil end
        scanner = tip
    end
    local tip = scanner
    local ok, regions = pcall(function()
        tip:SetOwner(resolve("WorldFrame") or resolve("UIParent"), "ANCHOR_NONE")
        tip:ClearLines()
        tip:SetHyperlink(link)
        return { tip:GetRegions() }
    end)
    if not ok or type(regions) ~= "table" then return nil end
    local out, capped = {}, nil
    for _, region in ipairs(regions) do
        local text, isRight = regionText(region)
        if text then
            local last = out[#out]
            if isRight and last and last.r == nil then
                last.r = text
            elseif #out >= MAX_TOOLTIP_LINES then
                capped = true
                break
            else
                out[#out + 1] = { l = text }
            end
        end
    end
    pcall(function() tip:Hide() end)
    return out, capped
end

-- Fill entry.tooltip (and tooltipCapped, tooltipPath) from C_TooltipInfo.<fn>(...);
-- when that is missing or gives nothing, from the scanning tooltip with link.
-- Lines that can name another player are dropped and counted on record.
local function addTooltip(entry, record, fn, link, ...)
    local path = "C_TooltipInfo." .. fn
    local lines, capped
    if has(path) then
        local ok, data = call(path, ...)
        if ok then
            lines, capped = tooltipFromData(data)
        else
            entry.tooltipError = scalar(tostring(data))
        end
        if lines then entry.tooltipPath = path end
    end
    if not lines and link then
        lines, capped = scanTooltip(link)
        if lines then entry.tooltipPath = "scanTooltip" end
    end
    if not lines then
        entry.tooltipPath = "none"
        return
    end
    local kept, dropped = dropPrivate(lines)
    entry.tooltip, entry.tooltipCapped = kept, capped
    if dropped > 0 and record then record.droppedTooltipLines = (record.droppedTooltipLines or 0) + dropped end
end

-- ---------------------------------------------------------------------------
-- Saved data

local function ensureDump()
    local db = WF.db
    if type(db) ~= "table" then return nil end
    local dump = db.dump
    if type(dump) ~= "table" then
        dump = {}
        db.dump = dump
    end
    if type(dump.meta) ~= "table" then dump.meta = {} end
    if type(dump.meta.sections) ~= "table" then dump.meta.sections = {} end
    if type(dump.maps) ~= "table" then dump.maps = {} end
    if type(dump.trainer) ~= "table" then dump.trainer = {} end
    return dump
end

-- The header of a main dump (trainer and maps keep their own timestamps).
local function refreshMeta(dump)
    local meta = dump.meta
    meta.addonVersion = WF.version
    meta.development = WF.isDevelopment
    local ok, version, build, buildDate, interface = call("GetBuildInfo")
    if ok then
        meta.build = { version = scalar(version), build = scalar(build), date = scalar(buildDate),
            interface = scalar(interface) }
        meta.interface = meta.build.interface
    end
    meta.projectId = scalar(resolve("WOW_PROJECT_ID"))
    meta.locale = first("GetLocale")
    meta.time = dateString()
    meta.serverTime = first("GetServerTime")
    local classOk, _, classToken, classId = call("UnitClass", "player")
    if classOk then meta.class, meta.classId = scalar(classToken), scalar(classId) end
    local raceOk, _, raceToken, raceId = call("UnitRace", "player")
    if raceOk then meta.race, meta.raceId = scalar(raceToken), scalar(raceId) end
    meta.level = first("UnitLevel", "player")
    meta.faction = first("UnitFactionGroup", "player")
end

-- ---------------------------------------------------------------------------
-- Jobs: a list of phases; each phase returns RunChunked steps.

local function beginSection(job, name, path, keepData)
    local dump = job.dump
    local record = { status = "running", path = path, count = 0, time = dateString() }
    dump.meta.sections[name] = record
    job.sections[name] = { record = record, started = now() }
    if ACCUMULATING[name] then
        if type(dump[name]) ~= "table" then dump[name] = {} end
    elseif not keepData or type(dump[name]) ~= "table" then
        dump[name] = {}
    end
    return dump[name], record
end

-- Re-open a section for a follow-up phase (seed spells, seed items).
local function resumeSection(job, name)
    local section = job.sections[name]
    if not section then return nil end
    section.record.status = "running"
    return job.dump[name], section.record
end

local function endSection(job, name, status)
    local section = job.sections[name]
    if not section then return end
    local record = section.record
    if record.status == "running" then record.status = status or "ok" end
    record.seconds = round(now() - section.started, 2)
end

local function missingSection(job, name, detail, status)
    local _, record = beginSection(job, name, nil, true)
    record.status = status or "missing"
    record.detail = detail
    endSection(job, name)
end

local function progress(job, text)
    local t = now()
    if t - job.lastProgress >= PROGRESS_SECONDS then
        job.lastProgress = t
        WF.Print("dump: " .. text)
    end
end

local function summary(job)
    local parts = {}
    for _, name in ipairs(SECTIONS) do
        local section = job.sections[name]
        if section then
            local record = section.record
            local text = name .. " " .. (record.status == "ok" and tostring(record.count) or tostring(record.status))
            if record.capped then text = text .. " (capped)" end
            parts[#parts + 1] = text
        end
    end
    return table.concat(parts, ", ")
end

local function addCleanup(job, fn)
    job.cleanups[#job.cleanups + 1] = fn
end

local function runCleanups(job)
    local list = job.cleanups
    job.cleanups = {}
    for _, fn in ipairs(list) do WF:Call(MODULE_ID, fn, job) end
end

-- status: "done", "cancelled" or "error". Clears the job slot first, so a
-- failing callback can never leave it stuck.
local function finishJob(job, status)
    if jobs[job.slot] ~= job then return end
    jobs[job.slot] = nil
    job.status = status
    runCleanups(job)
    for name in pairs(job.sections) do
        endSection(job, name, status == "done" and "ok" or status)
    end
    if job.onFinish then WF:Call(MODULE_ID, job.onFinish, job, status) end
    if job.quiet then return end
    pcall(function()
        if status == "done" then
            WF.Print(job.label .. " complete: " .. summary(job) .. " - /reload to save")
        else
            WF.Print(job.label .. " stopped early (" .. status .. "): " .. summary(job)
                .. " - /reload to save what was read")
        end
    end)
end

local nextPhase

local function resume(job)
    if jobs[job.slot] ~= job or job.cancelled then return end
    local ok = WF:Call(MODULE_ID, nextPhase, job)
    if not ok then finishJob(job, "error") end
end

local function afterPhase(job, phase)
    if phase.finish then WF:Call(MODULE_ID, phase.finish, job) end
    local wait = 0
    if phase.wait then
        local ok, value = WF:Call(MODULE_ID, phase.wait, job)
        if ok and type(value) == "number" then wait = value end
    end
    if wait > 0 then
        job.waiting = true
        C_Timer.After(wait, function()
            job.waiting = nil
            resume(job)
        end)
    else
        resume(job)
    end
end

local function runSteps(job, phase, steps)
    job.handle = WF:RunChunked(steps, function(status)
        job.handle = nil
        if jobs[job.slot] ~= job then return end
        if status ~= "done" or job.cancelled then
            finishJob(job, status == "done" and "cancelled" or status)
            return
        end
        local ok = WF:Call(MODULE_ID, afterPhase, job, phase)
        if not ok then finishJob(job, "error") end
    end, BUDGET_MS, MODULE_ID)
end

nextPhase = function(job)
    while true do
        if jobs[job.slot] ~= job or job.cancelled then return end
        job.index = job.index + 1
        local phase = job.phases[job.index]
        if not phase then
            finishJob(job, "done")
            return
        end
        local ok, steps = WF:Call(MODULE_ID, phase.start, job)
        if ok and steps then
            runSteps(job, phase, steps)
            return
        end
        if phase.finish then WF:Call(MODULE_ID, phase.finish, job) end
    end
end

local function readSeeds()
    local seeds = WF.dumpSeeds
    local out = { items = {}, spells = {} }
    if type(seeds) ~= "table" then return out, false end
    for _, kind in ipairs({ "items", "spells" }) do
        local seen = {}
        if type(seeds[kind]) == "table" then
            for _, id in ipairs(seeds[kind]) do
                if type(id) == "number" and id > 0 and id == math.floor(id) and not seen[id]
                        and #out[kind] < MAX_SEEDS then
                    seen[id] = true
                    out[kind][#out[kind] + 1] = id
                end
            end
        end
    end
    return out, true
end

local function startJob(slot, label, phases, onFinish, fields)
    if jobs[slot] then
        WF.Print(label .. " is already running; wait for it to finish.")
        return false
    end
    local dump = ensureDump()
    if not dump then
        WF.Print("not ready yet; try again after login.")
        return false
    end
    local job = {
        slot = slot, label = label, phases = phases, index = 0, dump = dump, sections = {}, cleanups = {},
        lastProgress = now(), seeds = { items = {}, spells = {} }, knownSpells = {}, onFinish = onFinish,
    }
    for key, value in pairs(fields or {}) do job[key] = value end
    if slot == "main" then
        refreshMeta(dump)
        dump.meta.complete = false
        local seeds, seeded = readSeeds()
        job.seeds = seeds
        dump.meta.seeds = seeded and { items = #seeds.items, spells = #seeds.spells } or nil
    end
    jobs[slot] = job
    if not job.quietStart then
        WF.Print(label .. " started; keep playing normally, it runs a little each frame.")
    end
    resume(job)
    return true
end

local function cancelJobs()
    for _, job in pairs(jobs) do
        job.cancelled = true
        if job.handle and job.handle.IsRunning() then
            job.handle.Cancel()
        end
        finishJob(job, "cancelled")
    end
end

-- Steps from an array, each wrapped with a progress line.
local function each(job, list, label, fn)
    local steps = {}
    local count = #list
    for i = 1, count do
        local value = list[i]
        steps[i] = function()
            fn(value, i)
            progress(job, ("%s %d/%d"):format(label, i, count))
        end
    end
    return steps
end

-- ---------------------------------------------------------------------------
-- stats (base values only: effective values and modifiers include aura effects)

local function statsPhase()
    return {
        start = function(job)
            if not has("UnitStat") then
                missingSection(job, "stats", "UnitStat")
                return nil
            end
            local stats, record = beginSection(job, "stats", "UnitStat (base)")
            return { function()
                stats.primary = {}
                for index = 1, PRIMARY_STATS do
                    local ok, base = call("UnitStat", "player", index)
                    stats.primary[index] = ok and { index = index, base = scalar(base) }
                        or { index = index, error = scalar(tostring(base)) }
                end
                local armorOk, armorBase = call("UnitArmor", "player")
                stats.armor = armorOk and { base = scalar(armorBase) } or nil
                stats.level = first("UnitLevel", "player")
                local occupied = {}
                for slot = EQUIP_FIRST, EQUIP_LAST do
                    local id = first("GetInventoryItemID", "player", slot)
                    if id ~= nil then occupied[#occupied + 1] = slot end
                end
                stats.equippedSlots = occupied
                stats.naked = #occupied == 0
                stats.paths = { armor = has("UnitArmor"), inventory = has("GetInventoryItemID") }
                record.count = PRIMARY_STATS
            end }
        end,
        finish = function(job) endSection(job, "stats") end,
    }
end

-- ---------------------------------------------------------------------------
-- spells and racials

local COST_FIELDS = { "type", "name", "cost", "minCost", "costPerSec", "costPercent" }

local function powerCosts(spellId)
    if not has("C_Spell.GetSpellPowerCost") then return "missing" end
    local ok, costs = call("C_Spell.GetSpellPowerCost", spellId)
    if not ok then return "error" end
    if isSecret(costs) then return "secret" end
    if type(costs) ~= "table" then return "none" end
    local out = {}
    for i, cost in ipairs(costs) do
        if i > MAX_COSTS then break end
        if isSecret(cost) then
            out[i] = "secret"
        elseif type(cost) == "table" then
            local row = {}
            for _, field in ipairs(COST_FIELDS) do row[field] = scalar(cost[field]) end
            out[i] = row
        end
    end
    return out
end

local function addSpellDetails(entry, spellId, record)
    local ok, info = call("C_Spell.GetSpellInfo", spellId)
    if ok and not isSecret(info) and type(info) == "table" then
        if entry.name == nil then entry.name = scalar(info.name) end
        entry.castTime = scalar(info.castTime)
        entry.minRange = scalar(info.minRange)
        entry.maxRange = scalar(info.maxRange)
    end
    if entry.subtext == nil then
        entry.subtext = first("C_Spell.GetSpellSubtext", spellId) or first("GetSpellSubtext", spellId)
    end
    entry.costs = powerCosts(spellId)
    addTooltip(entry, record, "GetSpellByID", "spell:" .. spellId, spellId)
end

-- Enum value -> name (Enum.SpellBookItemType), for readable "kind" values.
local function enumName(enum, value)
    if type(enum) ~= "table" or value == nil or value == "secret" then return nil end
    for name, v in pairs(enum) do
        if v == value then return name end
    end
    return nil
end

-- Returns path, read(index) -> entry or nil at the end of the book.
local function spellbookReader()
    local getInfo = resolve("C_SpellBook.GetSpellBookItemInfo")
    local bank = resolve("Enum.SpellBookSpellBank.Player")
    if type(getInfo) == "function" and bank ~= nil then
        local types = resolve("Enum.SpellBookItemType")
        return "C_SpellBook.GetSpellBookItemInfo", function(index)
            local ok, info = pcall(getInfo, index, bank)
            if not ok or isSecret(info) or type(info) ~= "table" then return nil end
            local itemType = scalar(info.itemType)
            return {
                slot = index, id = scalar(info.spellID), name = scalar(info.name), subtext = scalar(info.subName),
                passive = scalar(info.isPassive), offSpec = scalar(info.isOffSpec), tab = scalar(info.skillLineIndex),
                itemType = itemType, kind = enumName(types, itemType),
            }
        end
    end
    local old = resolve("GetSpellBookItemInfo")
    if type(old) == "function" then
        local book = resolve("BOOKTYPE_SPELL") or "spell"
        return "GetSpellBookItemInfo", function(index)
            local ok, kind, id = pcall(old, index, book)
            if not ok then return nil end
            kind = known(kind)
            if kind == nil then return nil end
            return { slot = index, id = scalar(id), kind = kind }
        end
    end
    return nil
end

local function isSpellKind(kind)
    -- "Spell", "FutureSpell" (C_SpellBook) or "SPELL", "FUTURESPELL" (old API);
    -- flyouts and pet actions carry other IDs.
    return type(kind) ~= "string" or kind:lower():find("spell") ~= nil
end

local function isRacial(entry)
    return type(entry.subtext) == "string" and entry.subtext:lower():find("racial") ~= nil
end

-- storeSpells: write the spells section; wantRacials: write the racials section.
local function spellbookPhase(storeSpells, wantRacials)
    return {
        start = function(job)
            local path, read = spellbookReader()
            if not path then
                if storeSpells then
                    missingSection(job, "spells", "C_SpellBook.GetSpellBookItemInfo, GetSpellBookItemInfo")
                end
                if wantRacials then missingSection(job, "racials", "no spellbook API") end
                return nil
            end
            local spells, spellRecord, racials, racialRecord
            if storeSpells then spells, spellRecord = beginSection(job, "spells", path) end
            if wantRacials then
                racials, racialRecord = beginSection(job, "racials", path .. " + subtext contains 'racial'")
            end
            local record = spellRecord or racialRecord
            local index, done = 0, false
            return function()
                if done then return nil end
                return function()
                    index = index + 1
                    if index > MAX_SPELLBOOK_SLOTS or (spells and #spells >= DataDump.caps.spells) then
                        if spellRecord then spellRecord.capped = true end
                        done = true
                        return
                    end
                    local entry = read(index)
                    if not entry then
                        done = true
                        return
                    end
                    entry.source = "spellbook"
                    if type(entry.kind) == "string" then entry.future = entry.kind:lower():find("future") ~= nil end
                    if type(entry.id) == "number" and isSpellKind(entry.kind) then
                        job.knownSpells[entry.id] = true
                        addSpellDetails(entry, entry.id, record)
                    end
                    if spells then
                        spells[#spells + 1] = entry
                        spellRecord.count = #spells
                    end
                    if racials and isRacial(entry) then
                        racials[#racials + 1] = {
                            id = entry.id, name = entry.name, subtext = entry.subtext, passive = entry.passive,
                            tooltip = entry.tooltip, tooltipPath = entry.tooltipPath,
                        }
                        racialRecord.count = #racials
                    end
                    progress(job, ("spellbook slot %d"):format(index))
                end
            end
        end,
        finish = function(job)
            if storeSpells then endSection(job, "spells") end
            if wantRacials then endSection(job, "racials") end
        end,
    }
end

-- Ask the client to load seeded spells and items it has not cached yet.
local function seedRequestPhase(wantSpells, wantItems)
    return {
        start = function(job)
            local list = {}
            if wantSpells then
                for _, id in ipairs(job.seeds.spells) do list[#list + 1] = { kind = "spell", id = id } end
            end
            if wantItems then
                for _, id in ipairs(job.seeds.items) do list[#list + 1] = { kind = "item", id = id } end
            end
            if #list == 0 then return nil end
            job.seedRequests = 0
            return each(job, list, "requesting seeded data", function(seed)
                if seed.kind == "spell" then
                    if job.knownSpells[seed.id] then return end
                    local cached = known(first("C_Spell.IsSpellDataCached", seed.id))
                    if cached ~= true and has("C_Spell.RequestLoadSpellData") then
                        call("C_Spell.RequestLoadSpellData", seed.id)
                        job.seedRequests = job.seedRequests + 1
                    end
                else
                    -- GetItemInfo returns nil for an uncached item and asks
                    -- the server for it (GET_ITEM_INFO_RECEIVED follows).
                    local name = known(first("C_Item.GetItemInfo", seed.id) or first("GetItemInfo", seed.id))
                    if name == nil then job.seedRequests = job.seedRequests + 1 end
                end
            end)
        end,
        wait = function(job)
            return (job.seedRequests or 0) > 0 and SEED_WAIT_SECONDS or 0
        end,
    }
end

local function seedSpellsPhase()
    return {
        start = function(job)
            local list = {}
            for _, id in ipairs(job.seeds.spells) do
                if not job.knownSpells[id] then list[#list + 1] = id end
            end
            if #list == 0 then return nil end
            local spells, record = resumeSection(job, "spells")
            if not spells then return nil end
            record.seedPath = "C_Spell.GetSpellInfo"
            return each(job, list, "seeded spells", function(id)
                if #spells >= DataDump.caps.spells then
                    record.capped = true
                    return
                end
                local entry = { id = id, source = "seed" }
                local cached = known(first("C_Spell.IsSpellDataCached", id))
                if cached ~= nil then entry.cached = cached end
                addSpellDetails(entry, id, record)
                if entry.name == nil then entry.cached = false end
                spells[#spells + 1] = entry
                record.count = #spells
            end)
        end,
        finish = function(job) endSection(job, "spells") end,
    }
end

-- ---------------------------------------------------------------------------
-- talents (Classic-style trees through the talent globals)

local function talentTabName(tab)
    local ok, a, b = call("GetTalentTabInfo", tab)
    if not ok then return nil end
    -- Newer clients return id, name, ...; older ones name, icon, ...
    a, b = scalar(a), scalar(b)
    if type(a) == "number" then return b end
    return a
end

local function talentPrereqs(tab, index)
    if not has("GetTalentPrereqs") then return nil end
    local returns = callPacked("GetTalentPrereqs", tab, index)
    if not returns[1] then return nil end
    local out = {}
    for i = 2, returns.n, 3 do
        if #out >= MAX_PREREQS then break end
        out[#out + 1] = { tier = scalar(returns[i]), column = scalar(returns[i + 1]),
            learnable = scalar(returns[i + 2]) }
    end
    return out
end

local function talentsPhase()
    return {
        start = function(job)
            if not (has("GetNumTalentTabs") and has("GetNumTalents") and has("GetTalentInfo")) then
                missingSection(job, "talents", "GetNumTalentTabs, GetNumTalents, GetTalentInfo")
                local record = job.dump.meta.sections.talents
                record.cTraits = resolve("C_Traits") ~= nil
                record.cClassTalents = resolve("C_ClassTalents") ~= nil
                return nil
            end
            local talents, record = beginSection(job, "talents", "GetTalentInfo")
            record.prereqPath = has("GetTalentPrereqs") and "GetTalentPrereqs" or "missing"
            record.tooltipPath = "none (no talent tooltip API confirmed)"
            record.cTraits = resolve("C_Traits") ~= nil
            record.cClassTalents = resolve("C_ClassTalents") ~= nil
            local tabs = first("GetNumTalentTabs")
            if type(tabs) ~= "number" then
                record.status = "error"
                record.detail = "GetNumTalentTabs returned " .. tostring(tabs)
                return nil
            end
            if tabs > MAX_TALENT_TABS then
                record.capped = true
                tabs = MAX_TALENT_TABS
            end
            local list = {}
            record.tabs = {}
            for tab = 1, tabs do
                local tabName = talentTabName(tab)
                record.tabs[tab] = { index = tab, name = tabName }
                local count = first("GetNumTalents", tab)
                if type(count) == "number" then
                    if count > MAX_TALENTS_PER_TAB then
                        record.capped = true
                        count = MAX_TALENTS_PER_TAB
                    end
                    record.tabs[tab].talents = count
                    for index = 1, count do list[#list + 1] = { tab = tab, tabName = tabName, index = index } end
                end
            end
            return each(job, list, "talents", function(t)
                local returns = callPacked("GetTalentInfo", t.tab, t.index)
                local entry = { tab = t.tab, tabName = t.tabName, index = t.index }
                if returns[1] then
                    entry.raw = rawReturns(returns, 2)
                    -- Classic order: name, icon, tier, column, rank, maxRank.
                    entry.name = scalar(returns[2])
                    entry.tier = scalar(returns[4])
                    entry.column = scalar(returns[5])
                    entry.rank = scalar(returns[6])
                    entry.maxRank = scalar(returns[7])
                    entry.prereqs = talentPrereqs(t.tab, t.index)
                else
                    entry.error = scalar(tostring(returns[2]))
                end
                talents[#talents + 1] = entry
                record.count = #talents
            end)
        end,
        finish = function(job) endSection(job, "talents") end,
    }
end

-- ---------------------------------------------------------------------------
-- quests

-- How to read, change and restore the quest log selection, or nil when the
-- selection cannot be read (then it is never changed).
local function selectionApi()
    if has("C_QuestLog.GetSelectedQuest") and has("C_QuestLog.SetSelectedQuest") then
        return {
            path = "C_QuestLog.GetSelectedQuest",
            read = function() return known(first("C_QuestLog.GetSelectedQuest")) end,
            select = function(questId) call("C_QuestLog.SetSelectedQuest", questId) end,
            restore = function(value) call("C_QuestLog.SetSelectedQuest", value) end,
        }
    end
    if has("GetQuestLogSelection") and has("SelectQuestLogEntry") then
        return {
            path = "GetQuestLogSelection",
            read = function() return known(first("GetQuestLogSelection")) end,
            select = function(_, logIndex) call("SelectQuestLogEntry", logIndex) end,
            restore = function(value) call("SelectQuestLogEntry", value) end,
        }
    end
    return nil
end

local function questObjectives(questId)
    local ok, objectives = call("C_QuestLog.GetQuestObjectives", questId)
    if not ok or isSecret(objectives) or type(objectives) ~= "table" then return nil end
    local out = {}
    for i, objective in ipairs(objectives) do
        if i > MAX_OBJECTIVES then break end
        if not isSecret(objective) and type(objective) == "table" then
            out[i] = {
                text = scalar(objective.text), type = scalar(objective.type),
                numRequired = scalar(objective.numRequired), numFulfilled = scalar(objective.numFulfilled),
                finished = scalar(objective.finished),
            }
        end
    end
    return out
end

local function questRewards(entry, questId, logIndex, selection)
    -- The reward calls read the selected quest.
    selection.select(questId, logIndex)
    local choices = {}
    local count = known(first("GetNumQuestLogChoices", questId))
    if type(count) == "number" then
        for i = 1, math.min(count, MAX_REWARDS) do
            local row = {}
            local returns = callPacked("GetQuestLogChoiceInfo", i, questId)
            if returns[1] then
                row.raw = rawReturns(returns, 2)
                row.name, row.count = scalar(returns[2]), scalar(returns[4])
                row.quality, row.usable = scalar(returns[5]), scalar(returns[6])
            end
            local link = firstLink("GetQuestLogItemLink", "choice", i)
            row.itemID = linkItemId(link)
            if row.name == nil then row.name = linkName(link) end
            choices[i] = row
        end
    end
    entry.choices = choices
    local rewards = {}
    if has("GetQuestLogItemLink") then
        for i = 1, MAX_REWARDS do
            local link = firstLink("GetQuestLogItemLink", "reward", i)
            if not link then break end
            rewards[i] = { itemID = linkItemId(link), name = linkName(link) }
        end
    end
    entry.rewards = rewards
end

local function questsPhase()
    return {
        start = function(job)
            local modern = has("C_QuestLog.GetNumQuestLogEntries") and has("C_QuestLog.GetInfo")
            local classic = has("GetNumQuestLogEntries") and has("GetQuestLogTitle")
            if not (modern or classic) then
                missingSection(job, "quests", "C_QuestLog.GetInfo, GetQuestLogTitle")
                return nil
            end
            local path = modern and "C_QuestLog.GetInfo" or "GetQuestLogTitle"
            local quests, record = beginSection(job, "quests", path)
            record.objectivePath = has("C_QuestLog.GetQuestObjectives") and "C_QuestLog.GetQuestObjectives"
                or "missing"
            record.xpAndMoney = "not read (no confirmed API)"
            local selection = selectionApi()
            local original = selection and selection.read()
            if type(original) ~= "number" then selection = nil end
            if selection then
                record.rewardPath = "GetQuestLogItemLink, GetQuestLogChoiceInfo (selection via "
                    .. selection.path .. ")"
                local restored = false
                addCleanup(job, function()
                    if restored then return end
                    restored = true
                    selection.restore(original)
                    record.selectionRestored = true
                end)
            else
                record.rewardPath = "unavailable (the quest log selection cannot be read, so it is not changed)"
            end
            local entries = first(modern and "C_QuestLog.GetNumQuestLogEntries" or "GetNumQuestLogEntries")
            if type(entries) ~= "number" then return nil end
            if entries > MAX_QUESTS then
                record.capped = true
                entries = MAX_QUESTS
            end
            local list = {}
            for index = 1, entries do list[index] = index end
            return each(job, list, "quest log", function(index)
                local entry
                if modern then
                    local ok, info = call("C_QuestLog.GetInfo", index)
                    if not ok or isSecret(info) or type(info) ~= "table" or known(info.isHeader) == true then return end
                    entry = {
                        questID = scalar(info.questID), title = scalar(info.title), level = scalar(info.level),
                        suggestedGroup = scalar(info.suggestedGroup), difficultyLevel = scalar(info.difficultyLevel),
                        frequency = scalar(info.frequency), logIndex = index,
                    }
                else
                    local ok, title, level, group, isHeader, _, _, frequency, questId =
                        call("GetQuestLogTitle", index)
                    if not ok or known(isHeader) then return end
                    entry = {
                        questID = scalar(questId), title = scalar(title), level = scalar(level),
                        suggestedGroup = scalar(group), frequency = scalar(frequency), logIndex = index,
                    }
                end
                if type(entry.questID) == "number" then
                    entry.objectives = questObjectives(entry.questID)
                    if selection then
                        questRewards(entry, entry.questID, index, selection)
                    else
                        entry.rewardsUnavailable = true
                    end
                end
                quests[#quests + 1] = entry
                record.count = #quests
            end)
        end,
        finish = function(job)
            runCleanups(job)
            endSection(job, "quests")
        end,
    }
end

-- ---------------------------------------------------------------------------
-- items

local function itemInfoPath()
    if has("C_Item.GetItemInfo") then return "C_Item.GetItemInfo" end
    if has("GetItemInfo") then return "GetItemInfo" end
    return nil
end

local function itemStatsPath()
    if has("C_Item.GetItemStats") then return "C_Item.GetItemStats" end
    if has("GetItemStats") then return "GetItemStats" end
    return nil
end

-- Fill entry from item info and stats; returns the item's link if known.
local function addItemDetails(entry, linkOrId)
    local infoPath = itemInfoPath()
    local link = type(linkOrId) == "string" and linkOrId or nil
    if infoPath then
        local ok, name, infoLink, quality, itemLevel, minLevel, itemType, itemSubType, _, equipLoc, _, sellPrice,
            classId, subclassId = call(infoPath, linkOrId)
        if ok then
            name = scalar(name)
            if entry.name == nil then entry.name = name end
            entry.cached = name ~= nil
            entry.quality, entry.itemLevel, entry.requiredLevel = scalar(quality), scalar(itemLevel), scalar(minLevel)
            entry.itemType, entry.itemSubType = scalar(itemType), scalar(itemSubType)
            entry.equipSlot, entry.sellPrice = scalar(equipLoc), scalar(sellPrice)
            entry.classID, entry.subclassID = scalar(classId), scalar(subclassId)
            infoLink = known(infoLink)
            if link == nil and type(infoLink) == "string" then link = infoLink end
        end
    end
    local statsPath = itemStatsPath()
    if statsPath and link then
        local ok, stats = call(statsPath, link)
        if ok then entry.stats = plain(stats) end
    end
    return link
end

local function itemsPhase()
    return {
        start = function(job)
            local equipped = has("GetInventoryItemLink")
            local bags = has("C_Container.GetContainerNumSlots") and has("C_Container.GetContainerItemLink")
            if not (equipped or bags) then
                missingSection(job, "items", "GetInventoryItemLink, C_Container.GetContainerItemLink")
                return nil
            end
            local items, record = beginSection(job, "items",
                (equipped and "GetInventoryItemLink" or "-") .. " + " .. (bags and "C_Container" or "-"))
            record.infoPath = itemInfoPath() or "missing"
            record.statsPath = itemStatsPath() or "missing"
            local list = {}
            if equipped then
                for slot = EQUIP_FIRST, EQUIP_LAST do list[#list + 1] = { slot = slot } end
            end
            if bags then
                for bag = BAG_FIRST, BAG_LAST do
                    local slots = first("C_Container.GetContainerNumSlots", bag)
                    if type(slots) == "number" then
                        for slot = 1, slots do list[#list + 1] = { bag = bag, slot = slot } end
                    end
                end
            end
            return each(job, list, "items", function(place)
                if #items >= DataDump.caps.items then
                    record.capped = true
                    return
                end
                local link
                if place.bag then
                    link = firstLink("C_Container.GetContainerItemLink", place.bag, place.slot)
                else
                    link = firstLink("GetInventoryItemLink", "player", place.slot)
                end
                if not link then return end
                local entry = {
                    source = place.bag and "bag" or "equipped", bag = place.bag, slot = place.slot,
                    itemID = linkItemId(link), name = linkName(link),
                }
                if place.bag then
                    local ok, info = call("C_Container.GetContainerItemInfo", place.bag, place.slot)
                    if ok and not isSecret(info) and type(info) == "table" then
                        entry.count = scalar(info.stackCount)
                    end
                end
                addItemDetails(entry, link)
                if place.bag then
                    addTooltip(entry, record, "GetBagItem", link, place.bag, place.slot)
                else
                    addTooltip(entry, record, "GetInventoryItem", link, "player", place.slot)
                end
                items[#items + 1] = entry
                record.count = #items
            end)
        end,
        finish = function(job) endSection(job, "items") end,
    }
end

local function seedItemsPhase()
    return {
        start = function(job)
            if #job.seeds.items == 0 then return nil end
            local items, record = resumeSection(job, "items")
            if not items then
                items, record = beginSection(job, "items", "seeds only")
            end
            record.seedPath = itemInfoPath() or "missing"
            return each(job, job.seeds.items, "seeded items", function(id)
                if #items >= DataDump.caps.items then
                    record.capped = true
                    return
                end
                local entry = { source = "seed", itemID = id }
                local link = addItemDetails(entry, id)
                if entry.cached == nil then entry.cached = false end
                if entry.cached then addTooltip(entry, record, "GetItemByID", link, id) end
                items[#items + 1] = entry
                record.count = #items
            end)
        end,
        finish = function(job) endSection(job, "items") end,
    }
end

-- ---------------------------------------------------------------------------
-- maps (zone rows, from events)

local function zoneKey(row)
    return tostring(row.uiMapID) .. "\0" .. tostring(row.zoneText) .. "\0" .. tostring(row.subZoneText)
end

local function buildMapIndex(dump)
    mapIndex = {}
    for _, row in ipairs(dump.maps) do
        if type(row) == "table" then mapIndex[zoneKey(row)] = row end
    end
end

--- Record the current zone as a maps row (de-duplicated). Returns the row.
function DataDump.RecordZone(event)
    local dump = ensureDump()
    if not dump then return nil end
    if not mapIndex then buildMapIndex(dump) end
    local row = {
        uiMapID = first("C_Map.GetBestMapForUnit", "player"),
        zoneText = first("GetZoneText") or first("GetRealZoneText"),
        subZoneText = first("GetSubZoneText"),
    }
    local key = zoneKey(row)
    local existing = mapIndex[key]
    if existing then
        existing.seen = (tonumber(existing.seen) or 1) + 1
        return existing
    end
    local meta = dump.meta
    if #dump.maps >= MAX_MAP_ROWS then
        meta.mapsCapped = true
        return nil
    end
    if type(row.uiMapID) == "number" then
        local ok, info = call("C_Map.GetMapInfo", row.uiMapID)
        if ok and not isSecret(info) and type(info) == "table" then
            row.mapName, row.mapType, row.parentMapID = scalar(info.name), scalar(info.mapType),
                scalar(info.parentMapID)
        end
    end
    row.realZoneText = first("GetRealZoneText")
    local posOk, _, _, _, instanceId = call("UnitPosition", "player")
    if posOk then
        row.instanceID = scalar(instanceId)
        row.instancePath = "UnitPosition"
    end
    local instOk, instanceName, instanceType, _, _, _, _, _, instId = call("GetInstanceInfo")
    if instOk then
        row.instanceName, row.instanceType = scalar(instanceName), scalar(instanceType)
        if row.instanceID == nil then
            row.instanceID = scalar(instId)
            row.instancePath = "GetInstanceInfo"
        end
    end
    row.event = event
    row.seen = 1
    row.time = dateString()
    dump.maps[#dump.maps + 1] = row
    mapIndex[key] = row
    meta.sections.maps = { status = "ok", path = "events: C_Map.GetBestMapForUnit, C_Map.GetMapInfo",
        count = #dump.maps, capped = meta.mapsCapped, time = row.time }
    return row
end

-- ---------------------------------------------------------------------------
-- trainer

local function trainerPosition()
    local mapId = first("C_Map.GetBestMapForUnit", "player")
    local out = { uiMapID = mapId }
    if type(mapId) ~= "number" then return out end
    local ok, pos = call("C_Map.GetPlayerMapPosition", mapId, "player")
    if not ok or isSecret(pos) or type(pos) ~= "table" then return out end
    local xyOk, x, y = pcall(function() return pos:GetXY() end)
    if not xyOk then return out end
    x, y = scalar(x), scalar(y)
    out.x = type(x) == "number" and round(x * 100, 1) or x
    out.y = type(y) == "number" and round(y * 100, 1) or y
    return out
end

-- GetTrainerServiceInfo has two shapes; upstream (RXPGuides.lua OnTrainer)
-- reads name, category, icon, _, rank when the third value is a number, and
-- name, rank, category otherwise.
local function trainerService(index)
    local returns = callPacked("GetTrainerServiceInfo", index)
    local entry = { index = index }
    if not returns[1] then
        entry.error = scalar(tostring(returns[2]))
        return entry
    end
    entry.raw = rawReturns(returns, 2)
    entry.name = scalar(returns[2])
    local second, third = scalar(returns[3]), scalar(returns[4])
    if type(third) == "number" then
        entry.category, entry.rank = second, scalar(returns[6])
    else
        entry.rank, entry.category = second, third
    end
    entry.cost = first("GetTrainerServiceCost", index)
    entry.levelReq = first("GetTrainerServiceLevelReq", index)
    entry.skillLine = first("GetTrainerServiceSkillLine", index)
    return entry
end

local function countKeys(t)
    local n = 0
    for _ in pairs(t) do n = n + 1 end
    return n
end

-- The record is built in the job and saved only when the run is done (see
-- storeTrainerRecord), so a closed window never replaces a complete record.
local function trainerPhase()
    return {
        start = function(job)
            if not (has("GetNumTrainerServices") and has("GetTrainerServiceInfo")) then
                missingSection(job, "trainer", "GetNumTrainerServices, GetTrainerServiceInfo")
                return nil
            end
            local count = first("GetNumTrainerServices")
            if not trainerOpen and (type(count) ~= "number" or count == 0) then
                WF.Print("trainer dump: no trainer window is open. Talk to a trainer first.")
                job.quiet = true
                return nil
            end
            local dump = job.dump
            local guidOk, guid = call("UnitGUID", "npc")
            local npcId = guidOk and DataDump.ParseCreatureId(guid) or nil
            if not npcId then
                WF.Print("trainer dump: could not read this trainer's creature ID; nothing saved.")
                job.quiet = true
                return nil
            end
            local key = tostring(npcId)
            if dump.trainer[key] == nil and countKeys(dump.trainer) >= MAX_TRAINER_RECORDS then
                missingSection(job, "trainer", "trainer record cap reached", "capped")
                return nil
            end
            local position = trainerPosition()
            local record = {
                npcId = npcId, uiMapID = position.uiMapID, x = position.x, y = position.y,
                time = dateString(), tradeskill = known(first("IsTradeskillTrainer")),
                level = first("UnitLevel", "player"), filters = {}, services = {}, complete = false,
                paths = {
                    cost = has("GetTrainerServiceCost"), levelReq = has("GetTrainerServiceLevelReq"),
                    skillLine = has("GetTrainerServiceSkillLine"), spellId = false, tooltip = false,
                },
            }
            local filtersOff = {}
            for _, filter in ipairs(TRAINER_FILTERS) do
                local value = has("GetTrainerServiceTypeFilter") and known(first("GetTrainerServiceTypeFilter", filter))
                if value == nil then value = false end
                record.filters[filter] = value
                if value == false or value == 0 then filtersOff[#filtersOff + 1] = filter end
            end
            if #filtersOff > 0 then
                WF.Print("trainer dump: the trainer's filter hides " .. table.concat(filtersOff, ", ")
                    .. " services. Tick all filters (available, unavailable, used) and reopen the trainer "
                    .. "for a complete list.")
            end
            job.trainerKey, job.trainerRecord = key, record
            local _, section = beginSection(job, "trainer", "GetTrainerServiceInfo")
            section.lastNpcId = npcId
            if type(count) ~= "number" then count = 0 end
            if count > MAX_TRAINER_SERVICES then
                section.capped = true
                record.capped = true
                count = MAX_TRAINER_SERVICES
            end
            record.listed = count
            local list = {}
            for index = 1, count do list[index] = index end
            return each(job, list, "trainer services", function(index)
                record.services[#record.services + 1] = trainerService(index)
                section.count = #record.services
            end)
        end,
        finish = function(job) endSection(job, "trainer") end,
    }
end

-- Save the finished record unless a complete earlier record for the same
-- trainer lists more services.
local function storeTrainerRecord(job)
    local record, key = job.trainerRecord, job.trainerKey
    if not record then return end
    record.complete = not record.capped
    local existing = job.dump.trainer[key]
    local keep = type(existing) == "table" and existing.complete == true and type(existing.services) == "table"
        and #existing.services > #record.services
    local section = job.dump.meta.sections.trainer
    if keep then
        if section then section.kept = "an earlier complete record lists more services" end
        return
    end
    job.dump.trainer[key] = record
end

-- Fill trainer services' spellId from this dump's spellbook where name and
-- rank text match exactly one spell (spellIdSource = "spellbook").
local function linkTrainerSpellIds(dump)
    if type(dump.spells) ~= "table" or type(dump.trainer) ~= "table" then return end
    local byName = {}
    for _, spell in ipairs(dump.spells) do
        if type(spell.id) == "number" and type(spell.name) == "string" then
            local key = spell.name .. "\0" .. (type(spell.subtext) == "string" and spell.subtext or "")
            local seen = byName[key]
            if seen == nil then
                byName[key] = spell.id
            elseif seen ~= spell.id then
                byName[key] = false -- ambiguous: never guess
            end
        end
    end
    for _, record in pairs(dump.trainer) do
        for _, service in ipairs(type(record) == "table" and type(record.services) == "table" and record.services
                or {}) do
            if type(service.name) == "string" then
                local id = byName[service.name .. "\0" .. (type(service.rank) == "string" and service.rank or "")]
                if id then
                    service.spellId = id
                    service.spellIdSource = "spellbook"
                end
            end
        end
    end
end

-- ---------------------------------------------------------------------------
-- Commands

local function currentZonePhase()
    return {
        start = function()
            return { function() DataDump.RecordZone("dump") end }
        end,
    }
end

local SECTION_PHASES = {
    stats = function() return { statsPhase() } end,
    spells = function()
        return { spellbookPhase(true, false), seedRequestPhase(true, false), seedSpellsPhase() }
    end,
    racials = function() return { spellbookPhase(false, true) } end,
    talents = function() return { talentsPhase() } end,
    quests = function() return { questsPhase() } end,
    items = function() return { itemsPhase(), seedRequestPhase(false, true), seedItemsPhase() } end,
}

local function fullPhases()
    return {
        statsPhase(), spellbookPhase(true, true), seedRequestPhase(true, true), talentsPhase(), questsPhase(),
        itemsPhase(), seedSpellsPhase(), seedItemsPhase(), currentZonePhase(),
    }
end

local function afterMainDump(job, status)
    job.dump.meta.complete = status == "done" and job.full == true
    if status == "done" then linkTrainerSpellIds(job.dump) end
end

--- Start a dump: section nil for a full dump, or one section name.
function DataDump.Run(section)
    if jobs.main then
        WF.Print("a dump is already running; wait for it to finish.")
        return false
    end
    local phases, label
    if section == nil then
        phases, label = fullPhases(), "dump"
    elseif SECTION_PHASES[section] then
        phases, label = SECTION_PHASES[section](), "dump " .. section
    else
        return false
    end
    return startJob("main", label, phases, afterMainDump, { full = section == nil })
end

--- Dump the open trainer window (also runs on TRAINER_SHOW).
function DataDump.DumpTrainer()
    return startJob("trainer", "trainer dump", { trainerPhase() }, function(job, status)
        if status ~= "done" then return end
        storeTrainerRecord(job)
        linkTrainerSpellIds(job.dump)
    end)
end

function DataDump.IsRunning()
    return jobs.main ~= nil
end

function DataDump.IsTrainerRunning()
    return jobs.trainer ~= nil
end

local function printStatus()
    local dump = WF.db and WF.db.dump
    if jobs.main then WF.Print("a dump is running (" .. jobs.main.label .. ").") end
    if jobs.trainer then WF.Print("a trainer dump is running.") end
    if type(dump) ~= "table" or type(dump.meta) ~= "table" then
        WF.Print("no dump saved. /wf dump starts one.")
        return
    end
    local meta = dump.meta
    WF.Print(("dump from %s: %s %s level %s"):format(tostring(meta.time), tostring(meta.race),
        tostring(meta.class), tostring(meta.level)))
    for _, name in ipairs(SECTIONS) do
        local record = type(meta.sections) == "table" and meta.sections[name]
        if type(record) == "table" then
            WF.Print(("  %s: %s, %s entries%s (%s)"):format(name, tostring(record.status), tostring(record.count),
                record.capped and ", capped" or "", tostring(record.path)))
        else
            WF.Print("  " .. name .. ": not dumped")
        end
    end
    local trainers = type(dump.trainer) == "table" and countKeys(dump.trainer) or 0
    WF.Print(("  trainer records: %d; zone rows: %d"):format(trainers, type(dump.maps) == "table" and #dump.maps or 0))
    local seeds = WF.dumpSeeds
    if type(seeds) == "table" then
        WF.Print(("  development seeds loaded: %d items, %d spells"):format(
            type(seeds.items) == "table" and #seeds.items or 0, type(seeds.spells) == "table" and #seeds.spells or 0))
    end
end

local USAGE = "/wf dump [stats|spells|racials|talents|quests|items|trainer|maps|status|clear]"

local function slashDump(rest)
    local word = type(rest) == "string" and rest:match("^%s*(%S*)") or ""
    word = word:lower()
    if word == "" then
        DataDump.Run(nil)
    elseif word == "status" then
        printStatus()
    elseif word == "clear" then
        if jobs.main or jobs.trainer then
            WF.Print("a dump is running; clear it after it finishes.")
            return
        end
        if WF.db then WF.db.dump = nil end
        mapIndex = nil
        WF.Print("saved dump cleared. /reload to write the change to disk.")
    elseif word == "trainer" then
        DataDump.DumpTrainer()
    elseif word == "maps" then
        local row = DataDump.RecordZone("command")
        local dump = WF.db and WF.db.dump
        WF.Print(("zone row %s; %d zone rows saved."):format(row and "recorded" or "not recorded (cap reached)",
            type(dump) == "table" and #dump.maps or 0))
    elseif SECTION_PHASES[word] then
        DataDump.Run(word)
    else
        WF.Print("usage: " .. USAGE)
    end
end

-- ---------------------------------------------------------------------------
-- Events and registration

local function onEvent(_, event)
    if event == "TRAINER_SHOW" then
        trainerOpen = true
        DataDump.DumpTrainer()
    elseif event == "TRAINER_CLOSED" then
        trainerOpen = false
        local job = jobs.trainer
        if job and job.handle and job.handle.IsRunning() then job.handle.Cancel() end
    else
        DataDump.RecordZone(event)
    end
end

WF:RegisterModule(MODULE_ID, {
    title = "Data dump",
    desc = "Adds /wf dump: reads spell costs and tooltips, talents, quests, items, base stats, trainer lists "
        .. "and zone map IDs from the game and saves them (WayfinderData) for the developers. While on, it "
        .. "records each zone you enter and each trainer window you open.",
    default = false,
    devDefault = true,
    OnEnable = function()
        if not frame then frame = CreateFrame("Frame") end
        frame:SetScript("OnEvent", WF:Guard(MODULE_ID, onEvent))
        for _, event in ipairs(ZONE_EVENTS) do frame:RegisterEvent(event) end
        frame:RegisterEvent("TRAINER_SHOW")
        frame:RegisterEvent("TRAINER_CLOSED")
    end,
    OnDisable = function()
        cancelJobs()
        trainerOpen = false
        if frame then
            frame:UnregisterAllEvents()
            frame:SetScript("OnEvent", nil)
        end
        if scanner then pcall(function() scanner:Hide() end) end
    end,
    slash = {
        dump = slashDump,
    },
})
