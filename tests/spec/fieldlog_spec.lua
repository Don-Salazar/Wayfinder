-- Specs for Modules/FieldLog.lua: the field-log writer, ring buffer, events,
-- privacy and commands. All IDs, names and GUIDs here are made-up fixtures.

local wow = require("wow-api")
local loader = require("support.addon_loader")

local FILES = { "Modules/Core.lua", "Modules/FieldLog.lua" }

-- A value the stub's issecretvalue reports as secret.
local SECRET = setmetatable({}, { __tostring = function() return "<secret>" end })

local CREATURE_GUID = "Creature-0-1111-0-2222-99901-0000ABCDEF"
local OBJECT_GUID = "GameObject-0-1111-0-2222-99902-0000ABCDEF"
local PLAYER_GUID = "Player-1111-0ABCDEF0"

describe("Modules/FieldLog.lua", function()
  local addon, WF, FieldLog, s

  local function client_api()
    return {
      UnitXP = function() return s.xp end,
      UnitXPMax = function() return s.xpMax end,
      UnitLevel = function() return s.level end,
      UnitGUID = function(unit) return s.guids[unit] end,
      UnitName = function(unit) return s.names[unit] end,
      GetRealmName = function() return "Testrealm" end,
      GetBuildInfo = function() return "1.60.1", "99999", "Nov 1 2026", 16001 end,
      GetLocale = function() return "enUS" end,
      UnitClass = function() return "Warrior", "WARRIOR", 1 end,
      UnitRace = function() return "Troll", "Troll", 8 end,
      UnitFactionGroup = function() return "Horde" end,
      C_Map = { GetBestMapForUnit = function() return s.map end },
      issecretvalue = function(value) return value == SECRET end,
      time = function() return s.clock end,
    }
  end

  local function load(options)
    options = options or {}
    s = { xp = 100, xpMax = 1000, level = 5, guids = {}, names = { player = "Testchar" }, map = 9001,
      clock = 1000000 }
    wow.install(client_api())
    if options.release then wow.set_metadata({ Version = "1.0.0" }) end
    addon = options.addon or {}
    loader.load(FILES, addon, wow)
    WF = addon.WF
    FieldLog = WF.FieldLog
    if options.saved then
      for name, value in pairs(options.saved) do rawset(_G, name, value) end
    end
    WF:Initialize()
    if options.before then options.before() end
    WF:Start()
  end

  local function events(kind)
    local out = {}
    for _, event in ipairs(FieldLog.Linearize(FieldLog.GetLog())) do
      if kind == nil or event.k == kind then out[#out + 1] = event end
    end
    return out
  end

  local function our_frame()
    return wow.frames()[1]
  end

  local function registered_events()
    local list = {}
    for event in pairs(our_frame()._events) do list[#list + 1] = event end
    table.sort(list)
    return list
  end

  -- Every string anywhere in value.
  local function strings(value, out)
    out = out or {}
    if type(value) == "string" then
      out[#out + 1] = value
    elseif type(value) == "table" then
      for k, v in pairs(value) do
        strings(k, out)
        strings(v, out)
      end
    end
    return out
  end

  local function contains_string(value, text)
    for _, str in ipairs(strings(value)) do
      if str:find(text, 1, true) then return true end
    end
    return false
  end

  before_each(function() wow.install() end)
  after_each(function() wow.uninstall() end)

  describe("off", function()
    it("is off by default in a release build: no frames, no events, Log is a no-op", function()
      load({ release = true })
      assert.is_false(WF:IsEnabled("fieldlog"))
      assert.are.equal(0, #wow.frames())
      assert.are.equal(0, wow.registered_count())
      assert.is_false(WF.Log("note", { tx = "x" }))
      assert.is_false(WF.LogSelfTest({ results = {} }))
      assert.is_nil(rawget(_G, "WayfinderCharData").log)
    end)

    it("stops writing and unregisters everything when turned off", function()
      local messages = {}
      local fake = {
        RegisterMessage = function(_, message, fn) messages[message] = fn end,
        UnregisterMessage = function(_, message, fn)
          if messages[message] == fn then messages[message] = nil end
        end,
      }
      load({ addon = fake })
      assert.is_function(messages.RXP_GUIDE_LOADED)
      WF:SetEnabled("fieldlog", false)
      assert.are.equal(0, wow.registered_count())
      assert.is_nil(our_frame():GetScript("OnEvent"))
      assert.is_nil(messages.RXP_GUIDE_LOADED)
      assert.is_false(WF.Log("note", { tx = "x" }))
      WF:Guard("test", function() error("after off") end)()
      WF:SetEnabled("fieldlog", true)
      assert.are.equal(2, #events("session"))
    end)
  end)

  describe("on", function()
    it("is on by default in a development build with one frame and exactly its events", function()
      load()
      assert.is_true(WF:IsEnabled("fieldlog"))
      assert.are.equal(1, #wow.frames())
      assert.are.same({
        "ADDON_ACTION_BLOCKED", "ADDON_ACTION_FORBIDDEN", "PLAYER_LEVEL_UP", "PLAYER_LOGOUT",
        "PLAYER_XP_UPDATE", "QUEST_ACCEPTED", "QUEST_TURNED_IN",
      }, registered_events())
    end)

    it("gives every event n, k, t, lv and m", function()
      load()
      wow.advance(12.34)
      local n, event = WF.Log("note", { tx = "hello" })
      assert.are.equal(2, n) -- the session event is #1
      assert.are.equal("note", event.k)
      assert.are.equal(12.3, event.t)
      assert.are.equal(5, event.lv)
      assert.are.equal(9001, event.m)
      assert.is_nil(event.x)
      assert.is_false(WF.Log("not_a_kind", {}))
    end)

    it("takes zone-map coordinates from HereBeDragons, rounded to 0.1", function()
      local hbd = { GetPlayerZonePosition = function() return 0.41234, 0.5678, 1415 end }
      local libStub = setmetatable({}, { __call = function(_, name) return name == "HereBeDragons-2.0" and hbd end })
      load({ before = function()
        rawset(_G, "LibStub", libStub)
        wow.track("LibStub")
      end })
      local _, event = WF.Log("note", { tx = "here" })
      assert.are.equal(1415, event.m)
      assert.are.equal(41.2, event.x)
      assert.are.equal(56.8, event.y)
      hbd.GetPlayerZonePosition = function() return SECRET, SECRET, SECRET end
      _, event = WF.Log("note", { tx = "secret" })
      assert.are.equal(9001, event.m) -- falls back to C_Map; no x/y
      assert.is_nil(event.x)
    end)

    it("leaks no globals beyond its saved variables", function()
      wow.install(client_api())
      local before = loader.global_keys()
      load()
      local added = {}
      for _, key in ipairs(loader.new_globals(before, loader.global_keys())) do
        if not client_api()[key] then added[#added + 1] = key end
      end
      assert.are.same({ "WayfinderCharData", "WayfinderData" }, added)
    end)
  end)

  describe("ring buffer", function()
    it("wraps at the cap, keeps order and counts what it dropped", function()
      load()
      assert.is_true(WF:HandleSlash("log cap 1000"))
      for i = 1, 1500 do WF.Log("note", { tx = tostring(i) }) end
      local log = FieldLog.GetLog()
      assert.are.equal(1000, log.count)
      assert.are.equal(1000, #log.events)
      assert.are_not.equal(1, log.head)
      assert.are.equal(log.seq - 1000, log.dropped)
      local list = FieldLog.Linearize(log)
      assert.are.equal(1000, #list)
      for i = 2, #list do assert.are.equal(list[i - 1].n + 1, list[i].n) end
      assert.are.equal("1500", list[#list].tx)
    end)

    it("keeps the cap within 1000-50000", function()
      load()
      WF:HandleSlash("log cap 5")
      assert.are.equal(1000, FieldLog.GetLog().cap)
      WF:HandleSlash("log cap 999999")
      assert.are.equal(50000, FieldLog.GetLog().cap)
    end)

    it("starts with the default cap and repairs a damaged ring from saved data", function()
      load({ saved = { WayfinderCharData = { log = { v = 1, cap = 1000, head = 7, count = 3,
        events = { { n = 3, k = "note" }, { n = 1, k = "session" }, { n = 2, k = "note" } } } } } })
      local log = FieldLog.GetLog()
      local ns = {}
      for i, event in ipairs(FieldLog.Linearize(log)) do ns[i] = event.n end
      assert.are.same({ 1, 2, 3, 4 }, ns) -- repaired, then this session's event #4
      wow.uninstall()
      wow.install()
      load()
      assert.are.equal(20000, FieldLog.GetLog().cap)
    end)

    it("clears with /wf log clear and starts again with a session event", function()
      load()
      WF.Log("note", { tx = "x" })
      WF:HandleSlash("log clear")
      local list = events()
      assert.are.equal(1, #list)
      assert.are.equal("session", list[1].k)
      assert.are.equal(0, FieldLog.GetLog().dropped)
      WF:HandleSlash("log status")
      assert.is_true(wow.chat_contains("field log: 1 of 20000 events"))
    end)
  end)

  describe("session", function()
    it("records the build, character tokens and options, with an install id and no name or realm", function()
      load()
      local session = events("session")[1]
      local id = rawget(_G, "WayfinderData").installId
      assert.truthy(id:match("^%x%x%x%x%x%x%x%x%x%x%x%x$"))
      assert.are.equal(id, session.id)
      assert.are.equal(id, FieldLog.GetLog().id)
      assert.are.equal(1, session.s)
      assert.are.equal("0.1.0-dev", session.av)
      assert.are.equal("1.60.1", session.cv)
      assert.are.equal("99999", session.b)
      assert.are.equal(16001, session.i)
      assert.are.equal("enUS", session.loc)
      assert.are.equal("WARRIOR", session.cl)
      assert.are.equal("Troll", session.r)
      assert.are.equal("Horde", session.f)
      assert.is_nil(session.sp)
      assert.is_true(session.o.mods.fieldlog)
      assert.is_false(session.o.includeName)
      assert.is_nil(session.nm)
      assert.is_nil(session.rl)
      assert.is_false(contains_string(rawget(_G, "WayfinderCharData"), "Testchar"))
      assert.is_false(contains_string(rawget(_G, "WayfinderCharData"), "Testrealm"))
    end)

    it("keeps the install id across sessions and counts sessions", function()
      load()
      local id = FieldLog.GetLog().id
      WF:SetEnabled("fieldlog", false)
      WF:SetEnabled("fieldlog", true)
      assert.are.equal(id, FieldLog.GetLog().id)
      assert.are.equal(2, FieldLog.GetLog().sessions)
      assert.are.equal(2, events("session")[2].s)
    end)

    it("records name and realm only when the option is on", function()
      load()
      WF:SetOption("fieldlogIncludeName", true)
      WF:SetEnabled("fieldlog", false)
      WF:SetEnabled("fieldlog", true)
      local session = events("session")[2]
      assert.are.equal("Testchar", session.nm)
      assert.are.equal("Testrealm", session.rl)
      local options = WF:BuildOptionsTable()
      local toggle = options.args.fieldlog_opt_fieldlogIncludeName
      assert.are.equal("toggle", toggle.type)
      assert.is_true(toggle.get())
      assert.is_false(toggle.disabled())
    end)

    it("snapshots allowlisted upstream settings only", function()
      local fake = { settings = { profile = { xprate = 1.5, hardcore = false, enableQuestAutomation = true,
        debug = true, activeTheme = "x", dungeons = { a = true, b = false, c = true } } } }
      load({ addon = fake })
      local up = events("session")[1].o.up
      assert.are.same({ xprate = 1.5, hardcore = false, enableQuestAutomation = true, dungeonsOn = 2 }, up)
    end)

    it("fills the guide when the engine's guide-loaded message arrives", function()
      local messages = {}
      local fake = { RegisterMessage = function(_, message, fn) messages[message] = fn end }
      load({ addon = fake })
      assert.is_nil(events("session")[1].gd)
      messages.RXP_GUIDE_LOADED("RXP_GUIDE_LOADED", { key = "k1", name = "1-10 Test", group = "G", version = 3 })
      assert.are.same({ key = "k1", name = "1-10 Test", group = "G", version = 3 }, events("session")[1].gd)
      messages.RXP_GUIDE_LOADED("RXP_GUIDE_LOADED", { key = "k2", name = "10-20 Test", group = "G" })
      assert.are.same({ "k2" }, events("session")[1].gl)
    end)
  end)

  describe("quests", function()
    it("stores only the creature ID and name of an NPC giver", function()
      load()
      addon.currentGuide = { steps = { { elements = { { questId = 99001 }, { text = "x" } } } } }
      s.guids.npc = CREATURE_GUID
      s.names.npc = "Test Giver"
      wow.fire_event("QUEST_ACCEPTED", 99001)
      local event = events("quest_accept")[1]
      assert.are.equal(99001, event.q)
      assert.is_true(event.g)
      assert.are.equal(99901, event.c)
      assert.are.equal("Test Giver", event.nm)
      assert.is_false(contains_string(event, "Creature-"))
    end)

    it("stores the object ID for a game object, and nothing for a player", function()
      load()
      addon.currentGuide = { steps = { { elements = { { questId = 99001 } } } } }
      s.guids.npc, s.names.npc = OBJECT_GUID, "Test Chest"
      wow.fire_event("QUEST_ACCEPTED", 7, 99002) -- (logIndex, questID) form
      s.guids.npc, s.names.npc = PLAYER_GUID, "Someplayer"
      wow.fire_event("QUEST_ACCEPTED", 99003)
      s.guids.npc = SECRET
      wow.fire_event("QUEST_ACCEPTED", 99004)
      local list = events("quest_accept")
      assert.are.equal(99002, list[1].q)
      assert.is_false(list[1].g)
      assert.are.equal(99902, list[1].o)
      assert.are.equal(99003, list[2].q)
      assert.is_nil(list[2].c)
      assert.is_nil(list[2].o)
      assert.is_nil(list[2].nm)
      assert.is_false(contains_string(rawget(_G, "WayfinderCharData"), "Someplayer"))
      assert.is_nil(list[3].c)
      assert.is_nil(list[3].nm)
    end)

    it("leaves g unset without an active guide", function()
      load()
      wow.fire_event("QUEST_ACCEPTED", 99001)
      assert.is_nil(events("quest_accept")[1].g)
    end)

    it("records turn-ins with xp and money", function()
      load()
      addon.currentGuide = { steps = { { elements = { { questId = 99001 } } } } }
      wow.fire_event("QUEST_TURNED_IN", 99001, 450, 75)
      local event = events("quest_turnin")[1]
      assert.are.same({ 99001, 450, 75, true }, { event.q, event.xp, event.mo, event.g })
    end)

    it("parses giver GUIDs", function()
      load()
      assert.are.same({ "c", 99901 }, { FieldLog.ParseGiver(CREATURE_GUID) })
      assert.are.same({ "c", 99903 }, { FieldLog.ParseGiver("Vehicle-0-1-0-2-99903-00AB") })
      assert.are.same({ "o", 99902 }, { FieldLog.ParseGiver(OBJECT_GUID) })
      assert.is_nil(FieldLog.ParseGiver(PLAYER_GUID))
      assert.is_nil(FieldLog.ParseGiver("Pet-0-1-0-2-99904-00AB"))
      assert.is_nil(FieldLog.ParseGiver(nil))
      assert.is_nil(FieldLog.ParseGiver(SECRET))
    end)
  end)

  describe("xp", function()
    local function gain(xp, xpMax, level)
      s.xp = xp
      if xpMax then s.xpMax = xpMax end
      if level then s.level = level end
      wow.fire_event("PLAYER_XP_UPDATE", "player")
    end

    it("coalesces gains per second per source", function()
      load()
      gain(300)
      wow.next_frame()
      gain(350)
      wow.next_frame()
      assert.are.equal(0, #events("xp"))
      wow.advance(1.1)
      local list = events("xp")
      assert.are.equal(1, #list)
      assert.are.same({ 250, "other", 2, 5 }, { list[1].a, list[1].src, list[1].s, list[1].lv })
      gain(400)
      wow.next_frame()
      wow.advance(1.1)
      assert.are.equal(2, #events("xp"))
    end)

    it("counts the rest of the old level when a level-up wraps XP", function()
      load()
      gain(950)
      wow.next_frame()
      gain(50, 1200, 6)
      wow.next_frame()
      wow.advance(1.1)
      local list = events("xp")
      assert.are.equal(2, #list)
      assert.are.same({ 850, 5 }, { list[1].a, list[1].lv })
      assert.are.same({ 100, 6 }, { list[2].a, list[2].lv })
    end)

    it("labels XP next to a turn-in as quest XP, in either order", function()
      load()
      wow.fire_event("QUEST_TURNED_IN", 99001, 200, 0)
      gain(300)
      wow.next_frame()
      wow.advance(1.1)
      wow.advance(5)
      gain(500)
      wow.fire_event("QUEST_TURNED_IN", 99002, 200, 0)
      wow.next_frame()
      wow.advance(1.1)
      wow.advance(5)
      gain(510)
      wow.next_frame()
      wow.advance(1.1)
      local list = events("xp")
      assert.are.same({ "quest", "quest", "other" }, { list[1].src, list[2].src, list[3].src })
    end)

    it("ignores other units and writes pending XP at logout", function()
      load()
      s.xp = 900
      wow.fire_event("PLAYER_XP_UPDATE", "party1")
      gain(150 + 50)
      wow.next_frame()
      wow.fire_event("PLAYER_LOGOUT")
      local list = events("xp")
      assert.are.equal(1, #list)
      assert.are.equal(100, list[1].a)
    end)

    it("logs no xp and one probe when XP is secret", function()
      load({ before = function() s.xp = SECRET end })
      gain(SECRET)
      wow.next_frame()
      wow.advance(2)
      assert.are.equal(0, #events("xp"))
      local probes = events("probe")
      assert.are.equal(1, #probes)
      assert.are.equal("fieldlog.xp", probes[1].id)
      assert.are.equal("info", probes[1].st)
    end)
  end)

  describe("level", function()
    it("records the new level and /played from the leveling tracker when it has it", function()
      local fake = { tracker = { state = { login = { time = 999000, totalTimePlayed = 5000 } } } }
      load({ addon = fake })
      wow.fire_event("PLAYER_LEVEL_UP", 6)
      local event = events("level")[1]
      assert.are.same({ 6, 6, 6000 }, { event.nl, event.lv, event.pl })
      fake.tracker.state.login = nil
      wow.fire_event("PLAYER_LEVEL_UP", 7)
      assert.is_nil(events("level")[2].pl)
    end)
  end)

  describe("errors and blocked actions", function()
    it("logs a guarded error once, with its count, including errors from before it started", function()
      load({ before = function() WF:Guard("early", function() error("early boom") end)() end })
      local guarded = WF:Guard("test", function() error("boom") end)
      guarded()
      guarded()
      local list = events("error")
      assert.are.equal(2, #list)
      assert.are.equal("early", list[1].mod)
      assert.are.equal("test", list[2].mod)
      assert.truthy(list[2].msg:find("boom", 1, true))
      assert.are.equal(2, list[2].c)
      assert.is_string(list[2].st)
      assert.is_true(#list[2].st <= 2000)
    end)

    it("records blocked and forbidden actions of this addon only, counting repeats", function()
      load()
      wow.fire_event("ADDON_ACTION_BLOCKED", "OtherAddon", "CastSpellByID")
      wow.fire_event("ADDON_ACTION_FORBIDDEN", loader.ADDON_NAME, "TargetUnit()")
      wow.fire_event("ADDON_ACTION_FORBIDDEN", loader.ADDON_NAME, "TargetUnit()")
      wow.fire_event("ADDON_ACTION_BLOCKED", loader.ADDON_NAME, "UseAction()")
      local list = events("blocked")
      assert.are.equal(2, #list)
      assert.are.same({ "TargetUnit()", "forbidden", 2 }, { list[1].fn, list[1].ev, list[1].c })
      assert.are.same({ "UseAction()", "blocked", 1 }, { list[2].fn, list[2].ev, list[2].c })
      assert.are.equal(loader.ADDON_NAME, list[1].ad)
    end)
  end)

  describe("probes and notes", function()
    it("logs self-test results that did not pass, and a summary", function()
      load()
      local report = { status = "done", version = "0.1.0-dev", counts = { pass = 1, fail = 1, info = 1 },
        results = { { id = "a", status = "pass" }, { id = "b", status = "fail", detail = ("d"):rep(400) },
          { id = "c", status = "info" } } }
      WF:Fire("selftest", report)
      local list = events("probe")
      assert.are.equal(3, #list)
      assert.are.same({ "b", "fail", 200 }, { list[1].id, list[1].st, #list[1].dt })
      assert.are.equal("c", list[2].id)
      assert.are.same({ "selftest", "done", 1, 1 }, { list[3].id, list[3].st, list[3].sum.pass, list[3].sum.fail })
    end)

    it("saves /wf note text capped at 500 characters and prints its number", function()
      load()
      assert.is_true(WF:HandleSlash("note " .. ("x"):rep(600)))
      local note = events("note")[1]
      assert.are.equal(500, #note.tx)
      assert.is_true(wow.chat_contains("note saved as event #" .. note.n))
      WF:HandleSlash("note    ")
      assert.is_true(wow.chat_contains("usage: /wf note"))
      WF:HandleSlash("note " .. ("x"):rep(499) .. "\195\169")
      assert.are.equal(499, #events("note")[2].tx) -- the cut two-byte character is dropped
    end)
  end)
end)
