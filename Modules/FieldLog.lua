-- Modules/FieldLog.lua
-- Purpose: the Field log (docs/FIELD_LOG.md). Writes a structured event log
-- per character into WayfinderCharData.log (written to disk at /reload or
-- logout) so tools/analyze-log can find bugs, wrong guide data and slow
-- routing after a test session.
--   addon.WF.Log(kind, fields)   the one writer; returns the event number, or
--                                false when the module is off (any module may
--                                call it unconditionally)
--   /wf log [status|clear|cap <n>]   /wf note <text>
-- Events produced at this stage: session, probe, error, blocked,
-- quest_accept, quest_turnin, xp, level, note. The writer already accepts the
-- later kinds (step_show, step_done, step_skip, quest_absent, travel, death,
-- train, talent, equip, opportunity, macro); nothing here produces them, and
-- death and travel are never approximated from other events.
-- Rules this file keeps (CLAUDE.md, FIELD_LOG section 2):
--   * No combat state: no health, auras, cooldowns, threat, target or enemy
--     data, no combat-log or chat parsing, no PLAYER_REGEN_* events.
--   * Privacy: no chat, no other players' names, no character name or realm
--     unless the player turns on the fieldlogIncludeName option (session
--     fields pn, pr; turning the option off removes them from the stored
--     log). The session event carries a random per-install ID instead.
--   * One session per addon load: toggling the module keeps it.
--   * Every value the client may mark "secret" passes the issecretvalue check
--     (when the client has it) before anything else touches it.
--   * Off: no frames, no events, no messages, WF.Log is a no-op. On: one
--     frame registered for exactly the events in EVENTS, plus the engine's
--     guide-loaded message.
-- Licence: CC BY-NC-SA 4.0, Wayfinder contributors
-- Date: 2026-11-17

local addonName, addon = ...

local WF = addon.WF
if not WF then return end

local MODULE_ID = "fieldlog"
local LOG_VERSION = 1
local DEFAULT_CAP = 20000
local MIN_CAP, MAX_CAP = 1000, 50000
local MAX_NOTE = 500
local MAX_MESSAGE = 1000
local MAX_STACK = 2000
local MAX_STRING = 2000
local MAX_DETAIL = 200
local MAX_SETTING_STRING = 32
local MAX_GUIDES_PER_SESSION = 20
local XP_COALESCE_SECONDS = 1
-- QUEST_TURNED_IN and PLAYER_XP_UPDATE arrive in the same or adjacent frames,
-- in either order; an XP gain this close to a turn-in counts as quest XP.
local QUEST_XP_WINDOW = 0.5
local INCLUDE_NAME_OPTION = "fieldlogIncludeName"
local GUIDE_LOADED_MESSAGE = "RXP_GUIDE_LOADED" -- GuideWindow.lua:2155 (queued; payload: guide)

-- PLAYER_LOGOUT only flushes XP still waiting to be coalesced.
local EVENTS = {
    "QUEST_ACCEPTED", "QUEST_TURNED_IN", "PLAYER_XP_UPDATE", "PLAYER_LEVEL_UP",
    "ADDON_ACTION_BLOCKED", "ADDON_ACTION_FORBIDDEN", "PLAYER_LOGOUT",
}

-- Every kind of docs/FIELD_LOG.md section 3. Adding a producer later is one
-- WF.Log(kind, fields) call.
local KINDS = {
    session = true, probe = true, error = true, blocked = true, quest_accept = true, quest_turnin = true,
    xp = true, level = true, note = true,
    step_show = true, step_done = true, step_skip = true, quest_absent = true, travel = true, death = true,
    train = true, talent = true, equip = true, opportunity = true, macro = true,
}

-- Upstream settings that change routing or automation (names from the
-- defaults table in SettingsPanel.lua). Only booleans, numbers and short
-- strings are copied. dungeonsOn (count of enabled dungeons) is added.
local SETTING_KEYS = {
    "enableQuestAutomation", "enableQuestRewardAutomation", "enableQuestChoiceAutomation",
    "enableFPAutomation", "enableGossipAutomation", "enableXpStepSkipping", "enableAutomaticXpRate",
    "xprate", "phase", "season", "hardcore",
}

local FieldLog = {}
WF.FieldLog = FieldLog

local frame -- event frame, created on first enable
local active = false
local log -- WayfinderCharData.log while active
-- One session per addon load (login or /reload): toggling the module off and
-- on again keeps the session, its start time and its session event.
local sessionStarted = false
local sessionStart = 0
local sessionEvent -- this session's session event (guide fields are filled in on load)
local generation = 0 -- bumped on enable and disable; stale timers compare it
local guideSet, guideSetFor -- quest ID set and the guide table it was built from
local xp = {} -- { cur, max, lv, disabled }
local turnIns = {} -- GetTime() of recent QUEST_TURNED_IN events
local held = {} -- XP samples waiting QUEST_XP_WINDOW for a turn-in on either side
local pending = {} -- source -> { a = amount, s = samples, lv = level, ap = approximate }
local loggedErrors = {} -- Core error record -> its logged event
local blockedIndex = {} -- event .. "\0" .. function -> its logged event
local blockedEntries = 0
local MAX_BLOCKED_INDEX = 200
local guideCallback -- the function registered for GUIDE_LOADED_MESSAGE

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

-- True only when the client says the value is secret. Never reads the value.
local function isSecret(value)
    local check = resolve("issecretvalue")
    if type(check) ~= "function" then return false end
    local ok, secret = pcall(check, value)
    return ok and secret == true
end

local function call(path, ...)
    local fn = resolve(path)
    if type(fn) ~= "function" then return false, "missing" end
    return pcall(fn, ...)
end

--- text cut to at most limit bytes without splitting a UTF-8 character.
function FieldLog.TrimUtf8(text, limit)
    if #text <= limit then return text end
    text = text:sub(1, limit)
    local lead = text:find("[\192-\255][\128-\191]*$")
    if lead then
        local byte = text:byte(lead)
        local size = byte >= 240 and 4 or byte >= 224 and 3 or 2
        if #text - lead + 1 < size then text = text:sub(1, lead - 1) end
    end
    return text
end

local trimUtf8 = FieldLog.TrimUtf8

-- A plain copy of value: "secret", a capped string, a finite number, a
-- boolean, or a table of those (two levels deep). Anything else is nil.
local function clean(value, depth)
    if isSecret(value) then return "secret" end
    local kind = type(value)
    if kind == "string" then
        return trimUtf8(value, MAX_STRING)
    elseif kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then return tostring(value) end
        return value
    elseif kind == "boolean" then
        return value
    elseif kind == "table" and (depth or 0) < 2 then
        local out = {}
        for key, entry in pairs(value) do
            if not isSecret(key) and (type(key) == "string" or type(key) == "number") then
                out[key] = clean(entry, (depth or 0) + 1)
            end
        end
        return out
    end
    return nil
end

-- A readable number, or nil (secret and non-numbers give nil).
local function number(value)
    if isSecret(value) or type(value) ~= "number" or value ~= value then return nil end
    return value
end

-- First return of a global function as a plain scalar, or nil.
local function first(path, ...)
    local ok, value = call(path, ...)
    if not ok then return nil end
    value = clean(value)
    if type(value) == "table" then return nil end
    return value
end

local function now()
    return type(GetTime) == "function" and GetTime() or 0
end

local function round1(value)
    return math.floor(value * 10 + 0.5) / 10
end

local function dateString()
    local fn = resolve("date")
    if type(fn) ~= "function" then return nil end
    local ok, text = pcall(fn, "%Y-%m-%d %H:%M:%S")
    return ok and type(text) == "string" and text or nil
end

local function level()
    return number(first("UnitLevel", "player"))
end

-- UiMapID and zone-map coordinates (percent, 0-100, the space guide .goto
-- coordinates use), rounded to 0.1. Source: HereBeDragons-2.0
-- GetPlayerZonePosition, the library the engine's own player position comes
-- from (map.lua:5, 123). Without it, only the UiMapID from
-- C_Map.GetBestMapForUnit is recorded and x/y are omitted.
local function position()
    local libStub = resolve("LibStub")
    local hbd
    if libStub ~= nil then
        local ok, lib = pcall(libStub, "HereBeDragons-2.0", true)
        if ok and type(lib) == "table" then hbd = lib end
    end
    if hbd and type(hbd.GetPlayerZonePosition) == "function" then
        local ok, x, y, mapId = pcall(hbd.GetPlayerZonePosition, hbd)
        x, y, mapId = ok and number(x), ok and number(y), ok and number(mapId)
        if mapId then
            if x and y then return mapId, round1(x * 100), round1(y * 100) end
            return mapId
        end
    end
    return number(first("C_Map.GetBestMapForUnit", "player"))
end

-- ---------------------------------------------------------------------------
-- Saved data: WayfinderCharData.log, an indexed ring buffer.
--   { v, id, sessions, cap, events, head, count, dropped, seq }
-- events[head] is the oldest event; the next one goes to
-- ((head - 1 + count) % cap) + 1. While count < cap, head is 1, so events is
-- always a gap-free array of count entries.

local function clampCap(value)
    value = math.floor(tonumber(value) or DEFAULT_CAP)
    if value < MIN_CAP then return MIN_CAP end
    if value > MAX_CAP then return MAX_CAP end
    return value
end

--- The per-install random ID (account-wide WayfinderData.installId),
--- created on first use.
function FieldLog.InstallId()
    local db = WF.db
    if type(db) ~= "table" then return nil end
    if type(db.installId) == "string" and db.installId:match("^%x+$") then return db.installId end
    -- math.random as the client seeded it (never math.randomseed: that would
    -- change the shared generator for every addon), mixed with a table's
    -- address text and the clocks.
    local mix = tonumber((tostring({}):match("(%x+)%s*$") or "0"):sub(-7), 16) or 0
    local clock = resolve("time")
    local ok, seconds = false, nil
    if type(clock) == "function" then ok, seconds = pcall(clock) end
    mix = mix + (ok and tonumber(seconds) or 0) % 1000003 + math.floor(now() * 1000) % 1000003
    local profile = resolve("debugprofilestop")
    if type(profile) == "function" then
        local profOk, ms = pcall(profile)
        if profOk then mix = mix + math.floor(tonumber(ms) or 0) % 1000003 end
    end
    local parts = {}
    for i = 1, 3 do
        local value = (math.random(0, 65535) + math.floor(mix / (65536 ^ (i - 1)))) % 65536
        parts[i] = ("%04x"):format(value)
    end
    db.installId = table.concat(parts)
    return db.installId
end

local function newLog(id, cap)
    return { v = LOG_VERSION, id = id, sessions = 0, cap = cap or DEFAULT_CAP, events = {}, head = 1, count = 0,
        dropped = 0, seq = 0 }
end

local function isWhole(value, low, high)
    return type(value) == "number" and value == math.floor(value) and value >= low and value <= high
end

local function isValidRing(saved)
    local cap, count, head, events = saved.cap, saved.count, saved.head, saved.events
    if not (isWhole(cap, MIN_CAP, MAX_CAP) and isWhole(count, 0, cap) and isWhole(head, 1, cap)) then return false end
    if count < cap and head ~= 1 then return false end
    for i = 1, count do
        if type(events[i]) ~= "table" then return false end
    end
    return events[count + 1] == nil
end

--- The events of a log in order, oldest first.
function FieldLog.Linearize(saved)
    local out = {}
    if type(saved) ~= "table" or type(saved.events) ~= "table" then return out end
    if isValidRing(saved) then
        for i = 0, saved.count - 1 do
            out[#out + 1] = saved.events[((saved.head - 1 + i) % saved.cap) + 1]
        end
        return out
    end
    -- Damaged ring: keep every event that has a sequence number, in order.
    for _, event in pairs(saved.events) do
        if type(event) == "table" and type(event.n) == "number" then out[#out + 1] = event end
    end
    table.sort(out, function(a, b) return a.n < b.n end)
    return out
end

-- Rebuild saved from an ordered list with a new cap (oldest dropped first).
local function rebuild(saved, list, cap)
    local start = math.max(1, #list - cap + 1)
    local events = {}
    for i = start, #list do events[#events + 1] = list[i] end
    saved.dropped = (tonumber(saved.dropped) or 0) + (start - 1)
    saved.events, saved.head, saved.count, saved.cap = events, 1, #events, cap
end

local function ensureLog()
    local charDb = WF.charDb
    if type(charDb) ~= "table" then return nil end
    local id = FieldLog.InstallId()
    local saved = charDb.log
    if type(saved) ~= "table" or saved.v ~= LOG_VERSION or type(saved.events) ~= "table" then
        if type(saved) == "table" then
            WF.Print(("field log: the saved log (format %s) cannot be read by this version and was discarded.")
                :format(tostring(saved.v)))
        end
        saved = newLog(id)
        charDb.log = saved
    elseif not isValidRing(saved) then
        local list = FieldLog.Linearize(saved)
        local entries = 0
        for _ in pairs(saved.events) do entries = entries + 1 end
        -- Entries that are not events are lost in the repair: count them.
        saved.dropped = (tonumber(saved.dropped) or 0) + (entries - #list)
        rebuild(saved, list, clampCap(saved.cap))
    end
    saved.id = id
    saved.sessions = tonumber(saved.sessions) or 0
    saved.dropped = tonumber(saved.dropped) or 0
    saved.seq = tonumber(saved.seq) or 0
    -- Never reuse a sequence number, even if seq was lost or damaged.
    local newest = saved.count > 0 and saved.events[((saved.head - 2 + saved.count) % saved.cap) + 1]
    if type(newest) == "table" and type(newest.n) == "number" and newest.n > saved.seq then saved.seq = newest.n end
    return saved
end

local function push(event)
    local cap = log.cap
    if log.count < cap then
        log.events[((log.head - 1 + log.count) % cap) + 1] = event
        log.count = log.count + 1
    else
        log.events[log.head] = event
        log.head = log.head % cap + 1
        log.dropped = log.dropped + 1
    end
end

--- Write one event. fields: short keys, plain values (copied). Every event
--- also gets n (sequence number), k (kind), t (seconds since session start,
--- 0.1 resolution), lv (level), m (UiMapID), x, y (zone-map percent, 0.1)
--- unless fields already set them. Returns the event number and the stored
--- event, or false when the module is off or the kind is unknown.
function WF.Log(kind, fields)
    if not active or not log or not KINDS[kind] then return false end
    local event = {}
    if type(fields) == "table" then
        for key, value in pairs(fields) do
            if type(key) == "string" then event[key] = clean(value) end
        end
    end
    log.seq = log.seq + 1
    event.n = log.seq
    event.k = kind
    event.t = round1(now() - sessionStart)
    if event.lv == nil then event.lv = level() end
    if event.m == nil and event.x == nil then event.m, event.x, event.y = position() end
    push(event)
    return event.n, event
end

-- ---------------------------------------------------------------------------
-- Session

-- Guide identity. The engine keeps no raw guide text on addon.currentGuide
-- (the text lives in GuideLoader's local embeddedGuides), so no content hash
-- is possible here; key, name, group and version identify the guide.
local function guideInfo(guide)
    if type(guide) ~= "table" then return nil end
    return { key = clean(guide.key), name = clean(guide.name), group = clean(guide.group),
        version = clean(guide.version) }
end

local function optionsSnapshot()
    local mods = {}
    for _, id in ipairs(WF.GetModuleIds()) do mods[id] = WF:IsEnabled(id) end
    local out = { mods = mods, includeName = WF:GetOption(INCLUDE_NAME_OPTION) }
    local settings = addon.settings
    local profile = type(settings) == "table" and settings.profile
    if type(profile) == "table" then
        local upstream = {}
        for _, key in ipairs(SETTING_KEYS) do
            local value = profile[key]
            local kind = type(value)
            if kind == "boolean" or kind == "number" or (kind == "string" and #value <= MAX_SETTING_STRING) then
                upstream[key] = value
            end
        end
        if type(profile.dungeons) == "table" then
            local on = 0
            for _, enabled in pairs(profile.dungeons) do
                if enabled == true then on = on + 1 end
            end
            upstream.dungeonsOn = on
        end
        out.up = upstream
    end
    return out
end

local function logSession(newSession)
    if newSession then log.sessions = log.sessions + 1 end
    local _, version, build, _, interface = call("GetBuildInfo")
    local _, _, classToken = call("UnitClass", "player")
    local _, _, raceToken = call("UnitRace", "player")
    local fields = {
        s = log.sessions, id = log.id, av = WF.version, dev = WF.isDevelopment,
        cv = version, b = build, i = interface, loc = first("GetLocale"),
        cl = classToken, r = raceToken, f = first("UnitFactionGroup", "player"),
        d = dateString(), gd = guideInfo(addon.currentGuide), sp = nil, o = optionsSnapshot(),
    }
    -- pn / pr: the player's own name and realm (not nm, the NPC name on quest_accept).
    if WF:GetOption(INCLUDE_NAME_OPTION) then
        fields.pn = first("UnitName", "player")
        fields.pr = first("GetRealmName")
    end
    local _, event = WF.Log("session", fields)
    sessionEvent = event or nil
end

--- Remove the player's name and realm from every stored session event.
function FieldLog.ScrubNames(saved)
    if type(saved) ~= "table" or type(saved.events) ~= "table" then return end
    for _, event in pairs(saved.events) do
        if type(event) == "table" and event.k == "session" then
            event.pn, event.pr = nil, nil
        end
    end
end

-- Core's "option" notification: turning the name option off scrubs the log.
local function onOption(key, value)
    if key == INCLUDE_NAME_OPTION and not value then
        FieldLog.ScrubNames(log or (type(WF.charDb) == "table" and WF.charDb.log))
    end
end

-- RXP_GUIDE_LOADED: fill the session's guide, or list a later guide switch.
local function onGuideLoaded(_, guide)
    guideSet, guideSetFor = nil, nil
    if not active or not sessionEvent then return end
    local info = guideInfo(guide) or guideInfo(addon.currentGuide)
    if not info then return end
    local current = sessionEvent.gd
    if current == nil then
        sessionEvent.gd = info
    elseif current.key ~= info.key then
        local list = sessionEvent.gl or {}
        sessionEvent.gl = list
        local last = list[#list]
        if last ~= info.key and #list < MAX_GUIDES_PER_SESSION then list[#list + 1] = info.key end
    end
end

-- ---------------------------------------------------------------------------
-- Quests

-- true / false whether the active guide has a step element for questId, or
-- nil with no active guide. The set is built once per guide table from its
-- steps' elements (element.questId, set at parse time in functions.lua).
local function questInGuide(questId)
    local guide = addon.currentGuide
    if type(guide) ~= "table" or type(guide.steps) ~= "table" then return nil end
    if guideSetFor ~= guide or not guideSet then
        guideSet, guideSetFor = {}, guide
        for _, step in ipairs(guide.steps) do
            if type(step) == "table" and type(step.elements) == "table" then
                for _, element in ipairs(step.elements) do
                    if type(element) == "table" and type(element.questId) == "number" then
                        guideSet[element.questId] = true
                    end
                end
            end
        end
    end
    return guideSet[questId] == true
end

--- Kind and ID from a unit GUID: "c" and the creature ID for Creature- and
--- Vehicle- GUIDs, "o" and the object ID for GameObject- GUIDs, nil for
--- anything else (players, pets, secret values). Server and spawn segments
--- are never kept.
function FieldLog.ParseGiver(guid)
    if isSecret(guid) or type(guid) ~= "string" then return nil end
    local unitType, id = guid:match("^(%a+)%-[^%-]*%-[^%-]*%-[^%-]*%-[^%-]*%-(%d+)%-[^%-]*$")
    if unitType == "Creature" or unitType == "Vehicle" then return "c", tonumber(id) end
    if unitType == "GameObject" then return "o", tonumber(id) end
    return nil
end

-- Quest-giving frames the engine itself checks (RXPGuides.lua:1079-1090).
-- The "npc" unit is only trusted as the giver while one of them is shown:
-- for shared, item-started or auto-accepted quests (the engine hides
-- QuestFrame on auto-accept) it may be stale or empty, so no giver is kept.
local GIVER_FRAMES = { "QuestFrame", "GossipFrame" }

local function giverFrameOpen()
    for _, name in ipairs(GIVER_FRAMES) do
        local f = resolve(name)
        if type(f) == "table" and type(f.IsShown) == "function" then
            local ok, shown = pcall(f.IsShown, f)
            if ok and not isSecret(shown) and shown == true then return true end
        end
    end
    return false
end

local function onQuestAccepted(arg1, arg2)
    -- Retail-family clients send (questID); older ones (logIndex, questID).
    -- The engine reads it the same way (RXPGuides.lua:1191: arg1 and arg2 or arg1).
    local questId = number(arg2) or number(arg1)
    if not questId then return end
    local fields = { q = questId, g = questInGuide(questId) }
    if giverFrameOpen() then
        local ok, guid = call("UnitGUID", "npc")
        local giverKind, giverId
        if ok then giverKind, giverId = FieldLog.ParseGiver(guid) end
        if giverKind then
            fields[giverKind] = giverId
            local nameOk, name = call("UnitName", "npc")
            if nameOk and not isSecret(name) and type(name) == "string" and name ~= "" then fields.nm = name end
        end
    end
    WF.Log("quest_accept", fields)
end

-- QUEST_TURNED_IN (questID, xpReward, moneyReward): the order the engine's
-- handlers read (RXPGuides.lua:1876, LevelingTracker.lua:313).
local function onQuestTurnedIn(questId, xpReward, moneyReward)
    questId = number(questId)
    if not questId then return end
    local t = now()
    local kept = {}
    for _, at in ipairs(turnIns) do
        if t - at <= QUEST_XP_WINDOW * 4 then kept[#kept + 1] = at end
    end
    kept[#kept + 1] = t
    turnIns = kept
    WF.Log("quest_turnin", { q = questId, xp = number(xpReward), mo = number(moneyReward),
        g = questInGuide(questId) })
end

-- ---------------------------------------------------------------------------
-- XP

local function readXp()
    local okCur, cur = call("UnitXP", "player")
    local okMax, max = call("UnitXPMax", "player")
    if not okCur or not okMax then return nil, "missing" end
    if isSecret(cur) or isSecret(max) then return nil, "secret" end
    if type(cur) ~= "number" or type(max) ~= "number" then return nil, "unreadable" end
    return cur, max
end

local function stopXp(reason)
    if xp.disabled then return end
    xp.disabled = reason
    WF.Log("probe", { id = "fieldlog.xp", st = reason == "secret" and "info" or "fail",
        dt = "UnitXP/UnitXPMax " .. reason .. "; no xp events this session" })
end

-- XP gained since the last sample, and whether that amount is approximate.
-- The level is sampled with the XP. A level-up (a higher level than the last
-- sample, or a drop in UnitXP while UnitLevel still lags) means the gain is
-- what was left of the old level plus the new value. Across more than one
-- level the levels in between are unknown, so the amount is marked
-- approximate. (A drop with the level unchanged moves the expected level up
-- by one, so the later UnitLevel catch-up is not counted twice.)
local function sampleXp(baseline)
    if xp.disabled then return nil end
    local cur, max = readXp()
    if not cur then
        stopXp(max)
        return nil
    end
    local lvNow = level()
    local previous, previousMax, previousLv = xp.cur, xp.max, xp.lv
    xp.cur, xp.max = cur, max
    if baseline or previous == nil then
        xp.lv = lvNow
        return nil
    end
    local jumps = (lvNow and previousLv) and (lvNow - previousLv) or 0
    local delta, approximate
    if jumps > 0 or cur < previous then
        delta = (previousMax - previous) + cur
        approximate = jumps > 1
        if jumps > 0 then
            xp.lv = lvNow
        elseif previousLv then
            xp.lv = previousLv + 1
        else
            xp.lv = lvNow
        end
    else
        delta = cur - previous
        if lvNow and (not previousLv or lvNow > previousLv) then xp.lv = lvNow end
    end
    if delta > 0 then return delta, approximate end
    return nil
end

local function flushSource(source)
    local bucket = pending[source]
    if not bucket then return end
    pending[source] = nil
    WF.Log("xp", { a = bucket.a, src = source, s = bucket.s, lv = bucket.lv, ap = bucket.ap or nil })
end

local function flushAll()
    local sources = {}
    for source in pairs(pending) do sources[#sources + 1] = source end
    table.sort(sources)
    for _, source in ipairs(sources) do flushSource(source) end
end

-- At most one xp event per second per source: the first gain opens a bucket
-- that is written XP_COALESCE_SECONDS later with every gain summed. A gain
-- at another level closes the bucket first, so XP stays with its level.
local function addXp(source, amount, atLevel, approximate)
    local bucket = pending[source]
    if bucket and bucket.lv ~= atLevel then
        flushSource(source)
        bucket = nil
    end
    if bucket then
        bucket.a = bucket.a + amount
        bucket.s = bucket.s + 1
        bucket.ap = bucket.ap or approximate
        return
    end
    pending[source] = { a = amount, s = 1, lv = atLevel, ap = approximate }
    local gen = generation
    C_Timer.After(XP_COALESCE_SECONDS, WF:Guard(MODULE_ID, function()
        if gen == generation and pending[source] and pending[source].lv == atLevel then flushSource(source) end
    end))
end

local function nearTurnIn(at)
    for _, t in ipairs(turnIns) do
        if math.abs(t - at) <= QUEST_XP_WINDOW then return true end
    end
    return false
end

-- Classify a held sample and move it into its bucket.
local function release(sample)
    if not sample.held then return end
    sample.held = false
    for i = #held, 1, -1 do
        if held[i] == sample then table.remove(held, i) end
    end
    addXp(nearTurnIn(sample.at) and "quest" or "other", sample.a, sample.lv, sample.ap)
end

-- Release every held sample (with the turn-ins seen so far) and write the buckets.
local function releaseAll()
    local list = {}
    for i, sample in ipairs(held) do list[i] = sample end
    for _, sample in ipairs(list) do release(sample) end
    flushAll()
end

local function onXpUpdate(unit)
    if isSecret(unit) or (unit ~= nil and unit ~= "player") then return end
    local delta, approximate = sampleXp(false)
    if not delta then return end
    -- Hold the sample for QUEST_XP_WINDOW seconds, then call it quest XP if a
    -- QUEST_TURNED_IN came within the window before or after it, and "other"
    -- otherwise. No chat or combat message is parsed and the engine uses no
    -- non-chat discovery event, so kill and exploration XP are both "other".
    local sample = { a = delta, at = now(), lv = level(), ap = approximate, held = true }
    held[#held + 1] = sample
    local gen = generation
    C_Timer.After(QUEST_XP_WINDOW, WF:Guard(MODULE_ID, function()
        if gen == generation then release(sample) end
    end))
end

-- ---------------------------------------------------------------------------
-- Level

-- /played seconds from upstream's leveling tracker, only if it already holds
-- them: tracker.state.login = { time, totalTimePlayed } from its last
-- TIME_PLAYED_MSG (LevelingTracker.lua:243, 249), plus wall-clock seconds
-- since. RequestTimePlayed is never called here (it prints to chat).
local function playedSeconds()
    local tracker = addon.tracker
    local state = type(tracker) == "table" and tracker.state
    local login = type(state) == "table" and state.login
    if type(login) ~= "table" then return nil end
    local total, at = number(login.totalTimePlayed), number(login.time)
    local clock = resolve("time")
    if not total or not at or type(clock) ~= "function" then return nil end
    local ok, current = pcall(clock)
    if not ok or type(current) ~= "number" then return nil end
    return math.floor(total + (current - at) + 0.5)
end

local function onLevelUp(newLevel)
    newLevel = number(newLevel)
    WF.Log("level", { nl = newLevel, lv = newLevel, pl = playedSeconds() })
end

-- ---------------------------------------------------------------------------
-- Errors, blocked actions, self-test

-- True while event is still in the ring (an indexed event that was evicted,
-- or removed by /wf log clear, must not be updated in place: the update
-- would be lost).
local function inRing(event)
    if not log or log.count == 0 or type(event) ~= "table" then return false end
    local oldest = log.events[log.head]
    return type(oldest) == "table" and type(oldest.n) == "number" and type(event.n) == "number"
        and event.n >= oldest.n and event.n <= log.seq
end

local function logError(record)
    if type(record) ~= "table" then return end
    local existing = loggedErrors[record]
    if existing and inRing(existing) then
        existing.c = record.count
        return
    end
    local stack = type(record.stack) == "string" and trimUtf8(record.stack, MAX_STACK) or nil
    local _, event = WF.Log("error", { msg = trimUtf8(tostring(record.message), MAX_MESSAGE), st = stack,
        mod = record.module, c = record.count })
    loggedErrors[record] = event or nil
end

local function drainErrors()
    for _, record in ipairs(WF:GetErrors()) do logError(record) end
    if WF.droppedRecord then logError(WF.droppedRecord) end
end

-- ADDON_ACTION_BLOCKED / ADDON_ACTION_FORBIDDEN (addonName, functionName):
-- only ours. Repeats of the same function raise the count of its event while
-- that event is in the ring; otherwise a new event starts. The index is
-- bounded (MAX_BLOCKED_INDEX entries, then it starts over).
local function onBlocked(event, blockedAddon, functionName)
    if isSecret(blockedAddon) or blockedAddon ~= addonName then return end
    local fn = clean(functionName)
    local key = event .. "\0" .. tostring(fn)
    local existing = blockedIndex[key]
    if existing and inRing(existing) then
        existing.c = (existing.c or 1) + 1
        return
    end
    local _, logged = WF.Log("blocked", { fn = fn, ad = blockedAddon,
        ev = event == "ADDON_ACTION_FORBIDDEN" and "forbidden" or "blocked", c = 1 })
    if not logged then return end
    if not existing then
        if blockedEntries >= MAX_BLOCKED_INDEX then
            blockedIndex, blockedEntries = {}, 0
        end
        blockedEntries = blockedEntries + 1
    end
    blockedIndex[key] = logged
end

--- Log a finished self-test report (WayfinderData.selftest's shape): one
--- probe event per result that did not pass, then one summary event.
--- Returns false when the module is off. SelfTest.lua will call it through
--- WF:Fire("selftest", report); until then it can be called directly.
function WF.LogSelfTest(report)
    if not active or type(report) ~= "table" then return false end
    for _, result in ipairs(type(report.results) == "table" and report.results or {}) do
        if type(result) == "table" and result.status ~= "pass" then
            local detail = clean(result.detail)
            if type(detail) == "string" then detail = trimUtf8(detail, MAX_DETAIL) end
            if type(detail) == "table" then detail = nil end
            WF.Log("probe", { id = result.id, st = result.status, dt = detail })
        end
    end
    local counts = type(report.counts) == "table" and report.counts or {}
    WF.Log("probe", { id = "selftest", st = report.status, sum = {
        pass = number(counts.pass), fail = number(counts.fail), missing = number(counts.missing),
        skipped = number(counts.skipped), info = number(counts.info),
    }, ver = report.version })
    return true
end

local function onSelfTest(report)
    WF.LogSelfTest(report)
end

-- ---------------------------------------------------------------------------
-- Commands

local function slashNote(rest)
    local text = type(rest) == "string" and rest:match("^%s*(.-)%s*$") or ""
    if text == "" then
        WF.Print("usage: /wf note <text>")
        return
    end
    local n = WF.Log("note", { tx = trimUtf8(text, MAX_NOTE) })
    if n then WF.Print(("note saved as event #%d. /reload to write it to disk."):format(n)) end
end

local function printStatus()
    local events = FieldLog.Linearize(log)
    WF.Print(("field log: %d of %d events, %d dropped, %d sessions, install id %s"):format(
        log.count, log.cap, log.dropped, log.sessions, tostring(log.id)))
    local oldest, newest = events[1], events[#events]
    if oldest then
        WF.Print(("  oldest #%d (%s, t=%ss), newest #%d (%s, t=%ss)"):format(oldest.n or 0, tostring(oldest.k),
            tostring(oldest.t), newest.n or 0, tostring(newest.k), tostring(newest.t)))
    end
    WF.Print("  /wf log clear | /wf log cap <" .. MIN_CAP .. "-" .. MAX_CAP .. "> | /wf note <text>")
end

local function slashLog(rest)
    local word, argument = (type(rest) == "string" and rest or ""):match("^%s*(%S*)%s*(.-)%s*$")
    word = (word or ""):lower()
    if word == "" or word == "status" then
        printStatus()
    elseif word == "clear" then
        log.events, log.head, log.count, log.dropped = {}, 1, 0, 0
        loggedErrors, blockedIndex, blockedEntries = {}, {}, 0
        logSession(false)
        WF.Print("field log cleared. /reload to write the change to disk.")
    elseif word == "cap" then
        local requested = tonumber(argument)
        if not requested then
            WF.Print(("usage: /wf log cap <%d-%d> (now %d)"):format(MIN_CAP, MAX_CAP, log.cap))
            return
        end
        local cap = clampCap(requested)
        local before = log.count
        rebuild(log, FieldLog.Linearize(log), cap)
        WF.Print(("field log cap is %d%s; %d events kept, %d dropped."):format(cap,
            cap ~= requested and " (limits " .. MIN_CAP .. "-" .. MAX_CAP .. ")" or "", log.count, before - log.count))
    else
        WF.Print("usage: /wf log [status|clear|cap <n>]")
    end
end

-- ---------------------------------------------------------------------------
-- Events and registration

local function onEvent(_, event, ...)
    if event == "QUEST_ACCEPTED" then
        onQuestAccepted(...)
    elseif event == "QUEST_TURNED_IN" then
        onQuestTurnedIn(...)
    elseif event == "PLAYER_XP_UPDATE" then
        onXpUpdate(...)
    elseif event == "PLAYER_LEVEL_UP" then
        onLevelUp(...)
    elseif event == "ADDON_ACTION_BLOCKED" or event == "ADDON_ACTION_FORBIDDEN" then
        onBlocked(event, ...)
    elseif event == "PLAYER_LOGOUT" then
        releaseAll()
    end
end

--- The live log table (nil while off). For specs and /wf commands.
function FieldLog.GetLog()
    return log
end

FieldLog.EVENTS = EVENTS
FieldLog.KINDS = KINDS

WF:RegisterModule(MODULE_ID, {
    title = "Field log",
    desc = "Keeps a log of this character's play (quests, XP, levels, errors, your /wf note lines) in the saved "
        .. "variables so the developers can find wrong guide data and slow routes. Nothing leaves your computer; "
        .. "no chat and no other players' names are recorded. /wf log shows its size.",
    default = false,
    devDefault = true,
    options = {
        {
            key = INCLUDE_NAME_OPTION,
            title = "Include character name and realm",
            desc = "Off: the log names this install only by a random ID. On: each session also records your "
                .. "character's name and realm.",
            default = false,
        },
    },
    OnEnable = function()
        log = ensureLog()
        if not log then error("field log: saved variables are not loaded", 0) end
        generation = generation + 1
        active = true
        pending, xp, turnIns, held = {}, {}, {}, {}
        guideSet, guideSetFor = nil, nil
        -- The name option may have been turned off while this module was off.
        if not WF:GetOption(INCLUDE_NAME_OPTION) then FieldLog.ScrubNames(log) end
        if not sessionStarted then
            sessionStarted = true
            sessionStart = now()
            logSession(true)
        end
        sampleXp(true)
        drainErrors()
        WF:On("error", logError)
        WF:On("selftest", onSelfTest)
        WF:On("option", onOption)
        if not frame then frame = CreateFrame("Frame") end
        frame:SetScript("OnEvent", WF:Guard(MODULE_ID, onEvent))
        for _, event in ipairs(EVENTS) do frame:RegisterEvent(event) end
        if type(addon.RegisterMessage) == "function" then
            -- The engine's wrapper calls fn(message, ...) and needs a function
            -- (RXPGuides.lua:65-77); removing it later names this callback.
            guideCallback = guideCallback or WF:Guard(MODULE_ID, onGuideLoaded)
            addon:RegisterMessage(GUIDE_LOADED_MESSAGE, guideCallback)
        end
    end,
    OnDisable = function()
        if active and log then releaseAll() end
        active = false
        generation = generation + 1
        pending, held = {}, {}
        WF:Off("error", logError)
        WF:Off("selftest", onSelfTest)
        WF:Off("option", onOption)
        if frame then
            frame:UnregisterAllEvents()
            frame:SetScript("OnEvent", nil)
        end
        if guideCallback and type(addon.UnregisterMessage) == "function" then
            addon:UnregisterMessage(GUIDE_LOADED_MESSAGE, guideCallback)
        end
        log = nil
    end,
    slash = {
        log = slashLog,
        note = slashNote,
    },
})
