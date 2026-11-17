-- Specs for Modules/SelfTest.lua (/wf selftest). The API set below is
-- synthetic: values are placeholders, not game data.

local wow = require("wow-api")
local loader = require("support.addon_loader")

local FILES = { "Modules/Core.lua", "Modules/SelfTest.lua" }
local LINK = "|cffffffff|Hitem:1::::::::1:::::::|h[Placeholder]|h|r"
local VALID = { pass = true, fail = true, missing = true, skipped = true, info = true }

-- A macro store that behaves like the client's for what the probes use:
-- bodies over 255 characters are cut to 255.
local function macro_api(store)
  local function index_of(name)
    for i, m in ipairs(store) do
      if m.name == name then return i end
    end
    return 0
  end
  return {
    CreateMacro = function(name, icon, body)
      store[#store + 1] = { name = name, icon = icon, body = body:sub(1, 255) }
      return #store
    end,
    EditMacro = function(index, name, icon, body)
      local m = assert(store[index], "no macro at index")
      m.name, m.icon = name or m.name, icon or m.icon
      if body then m.body = body:sub(1, 255) end
      return index
    end,
    DeleteMacro = function(index) table.remove(store, index) end,
    GetMacroIndexByName = index_of,
    GetMacroInfo = function(index)
      local m = store[index]
      if m then return m.name, m.icon, m.body end
    end,
    GetNumMacros = function() return 0, #store end,
    MAX_ACCOUNT_MACROS = 120,
    MAX_CHARACTER_MACROS = 18,
  }
end

local function full_api(store)
  local hbd = { GetPlayerZonePosition = function() return 0.25, 0.75, 1 end }
  local libs = { ["HereBeDragons-2.0"] = hbd }
  local api = {
    GetBuildInfo = function() return "0.0.0", "0", "Jan 1 2000", 16001 end,
    GetLocale = function() return "enUS" end,
    GetServerTime = function() return 1000 end,
    UnitRace = function() return "Race", "RACE", 1 end,
    UnitClass = function() return "Class", "CLASS", 1 end,
    UnitLevel = function() return 1 end,
    UnitFactionGroup = function() return "Faction", "Faction" end,
    UnitPosition = function() return 100.04, -200.06, 0, 0 end,
    C_Map = {
      GetBestMapForUnit = function() return 1 end,
      GetMapInfo = function() return { name = "Map" } end,
      GetPlayerMapPosition = function()
        return { GetXY = function() return 0.12345, 0.5 end }
      end,
    },
    C_QuestLog = {
      GetNumQuestLogEntries = function() return 2, 1 end,
      GetInfo = function(index)
        if index == 1 then return { isHeader = true, title = "Header" } end
        return { questID = 1, title = "Quest" }
      end,
      GetQuestObjectives = function() return { { type = "monster", text = "x" } } end,
    },
    C_Item = { GetItemStats = function() return { STAT_A = 1, STAT_B = 2 } end },
    GetInventoryItemLink = function() return LINK end,
    C_TooltipInfo = {
      GetInventoryItem = function() return { lines = { {}, {} } } end,
      GetBagItem = function() return { lines = { {} } } end,
    },
    C_Container = {
      GetContainerNumSlots = function(bag) return bag == 0 and 2 or 0 end,
      GetContainerItemLink = function(bag, slot) if bag == 0 and slot == 2 then return LINK end end,
    },
    Enum = { SpellBookSpellBank = { Player = 0 }, SpellBookItemType = { Spell = 1 } },
    C_SpellBook = {
      GetSpellBookItemInfo = function(index)
        if index <= 4 then return { spellID = index, name = "Spell", itemType = 1 } end
      end,
    },
    C_Spell = {
      GetSpellPowerCost = function() return { { type = 1, name = "POWER", cost = 10 } } end,
      GetSpellInfo = function() return { name = "Spell" } end,
    },
    C_ChatInfo = { RegisterAddonMessagePrefix = function() return 0 end },
    LibStub = setmetatable({ minors = { ["HereBeDragons-2.0"] = 1 } }, {
      __call = function(_, name) return libs[name] end,
    }),
  }
  for k, v in pairs(macro_api(store)) do api[k] = v end
  return api
end

-- Is `value` plain data (strings, numbers, booleans, tables of those with
-- string or number keys)? Returns false and a path on failure.
local function serializable(value, path)
  path = path or "selftest"
  local kind = type(value)
  if kind == "string" or kind == "number" or kind == "boolean" then return true end
  if kind ~= "table" then return false, path .. " is a " .. kind end
  for k, v in pairs(value) do
    if type(k) ~= "string" and type(k) ~= "number" then return false, path .. " has a " .. type(k) .. " key" end
    local ok, where = serializable(v, path .. "." .. tostring(k))
    if not ok then return false, where end
  end
  return true
end

describe("Modules/SelfTest.lua", function()
  local addon, WF, store

  local function start(overrides, metadata)
    store = {}
    local api = full_api(store)
    for k, v in pairs(overrides or {}) do api[k] = v end
    wow.install(api)
    if metadata then wow.set_metadata(metadata) end
    addon = loader.load(FILES, nil, wow)
    WF = addon.WF
    WF:Initialize()
    WF:Start()
  end

  local function run()
    assert.is_true(WF:HandleSlash("selftest"))
    for _ = 1, 1000 do
      if not WF.SelfTest.IsRunning() then break end
      wow.next_frame()
    end
    assert.is_false(WF.SelfTest.IsRunning())
    local report = rawget(_G, "WayfinderData").selftest
    assert.is_table(report)
    local by_id = {}
    for _, result in ipairs(report.results) do by_id[result.id] = result end
    return report, by_id
  end

  after_each(function() wow.uninstall() end)

  it("is on in development builds and registers nothing until run", function()
    start()
    assert.is_true(WF:IsEnabled("selftest"))
    assert.are.equal(0, #wow.frames())
    assert.are.equal(0, wow.registered_count())
    assert.are.equal(0, wow.pending_timers())
  end)

  it("is off in release builds: no run, no frames", function()
    start(nil, { Version = "1.0.0" })
    assert.is_false(WF:IsEnabled("selftest"))
    assert.is_true(WF:HandleSlash("selftest"))
    assert.is_true(wow.chat_contains("Self-test is off"))
    assert.are.equal(0, #wow.frames())
    assert.are.equal(0, wow.pending_timers())
    assert.is_nil(rawget(_G, "WayfinderData").selftest)
  end)

  it("writes a serializable report with every probe id, across several frames", function()
    start()
    local report, by_id = run()
    local ok, where = serializable(report)
    assert.is_true(ok, where)
    assert.is_true(report.complete)
    assert.are.equal(#WF.SelfTest.probes, #report.results)
    for _, probe in ipairs(WF.SelfTest.probes) do
      local result = by_id[probe.id]
      assert.is_table(result, "no result for " .. probe.id)
      assert.is_true(VALID[result.status], probe.id .. " status " .. tostring(result.status))
      assert.are.equal(probe.group, result.group)
    end
    assert.are.equal(16001, report.interface)
    assert.are.equal(18, report.projectId)
    assert.are.equal("enUS", report.locale)
    assert.are.equal("CLASS", report.character.class)
    assert.is_nil(report.character.name)
    assert.is_string(report.time.date)
    assert.are.equal(1000, report.time.server)
    local c = report.counts
    assert.are.equal(#report.results, c.pass + c.fail + c.missing + c.skipped + c.info)
    assert.is_true(wow.chat_contains("passed"))
    assert.is_true(wow.chat_contains("/reload to save"))
  end)

  it("records the expected values with the full API", function()
    start()
    local _, r = run()
    assert.are.equal("pass", r["client.project"].status)
    assert.are.equal("pass", r["client.locale"].status)
    assert.are.equal("pass", r["api.C_QuestLog.GetInfo"].status)
    assert.are.equal("missing", r["api.GetSpellPowerCost"].status)
    assert.are.same({ y = 100, x = -200.1, instance = 0 }, r["position.unit"].value)
    assert.are.equal(0.123, r["position.mapPosition"].value.x)
    assert.are.equal("pass", r["position.hereBeDragons"].status)
    assert.are.equal("pass", r["quests.sample"].status)
    assert.are.equal(1, r["quests.sample"].value[1].objectiveCount)
    assert.are.same({ "STAT_A", "STAT_B" }, r["items.mainhand"].value.statKeys)
    assert.are.equal(2, r["items.mainhand"].value.tooltipLines)
    assert.are.equal(1, r["items.mainhand"].value.itemId)
    assert.are.equal("pass", r["items.bag"].status)
    assert.are.equal(3, #r["spells.sample"].value.spells)
    assert.are.equal(10, r["spells.sample"].value.spells[1].costs[1].cost)
    assert.are.equal("pass", r["macros.roundtrip"].status)
    for _, id in ipairs({ "showtooltip", "castsequence", "equipslot", "stance", "modifiers" }) do
      assert.are.equal("pass", r["macros.body." .. id].status, id)
    end
    assert.are.equal("pass", r["macros.length.255"].status)
    assert.are.equal("info", r["macros.length.256"].status)
    assert.are.equal(255, r["macros.length.256"].value.stored)
    assert.are.equal("pass", r["secure.actionButton"].status)
    assert.are.equal("missing", r["cooldown.frameMethod"].status)
    assert.are.equal("pass", r["comm.registerPrefix"].status)
    assert.are.same({}, store) -- every scratch macro was deleted
  end)

  it("marks missing APIs as missing and never errors as a whole", function()
    wow.install()
    addon = loader.load(FILES, nil, wow)
    WF = addon.WF
    WF:Initialize()
    WF:Start()
    local report, r = run()
    assert.is_true(report.complete)
    assert.are.equal("missing", r["api.C_QuestLog.GetInfo"].status)
    assert.are.equal("missing", r["quests.count"].status)
    assert.are.equal("missing", r["macros.counts"].status)
    assert.are.equal("missing", r["position.unit"].status)
    assert.are.equal("missing", r["comm.registerPrefix"].status)
    local ok, where = serializable(report)
    assert.is_true(ok, where)
    assert.are.equal(0, #WF.errors)
  end)

  it("turns a throwing probe into a fail with the message", function()
    start({ GetLocale = function() error("locale exploded") end })
    local report, r = run()
    assert.are.equal("fail", r["client.locale"].status)
    assert.truthy(r["client.locale"].detail:find("locale exploded", 1, true))
    assert.is_true(report.complete)
    assert.is_nil(report.locale) -- the header survives the same failure
  end)

  it("skips the macro and secure probes in combat", function()
    start()
    wow.set_combat(true)
    local _, r = run()
    for id, result in pairs(r) do
      if id:find("^macros%.") or id == "secure.actionButton" then
        assert.are.equal("skipped", result.status, id)
        assert.are.equal("in combat", result.detail, id)
      end
    end
    assert.are.same({}, store)
  end)

  it("always deletes the scratch macro, even when a call fails", function()
    start({
      EditMacro = function() error("edit refused") end,
    })
    local _, r = run()
    assert.are.equal("fail", r["macros.roundtrip"].status)
    assert.truthy(r["macros.roundtrip"].detail:find("edit refused", 1, true))
    assert.are.same({}, store)
  end)

  it("skips macro probes when no character slot is free", function()
    start()
    for i = 1, 18 do store[i] = { name = "M" .. i, body = "" } end
    local _, r = run()
    assert.are.equal("skipped", r["macros.roundtrip"].status)
    assert.are.equal(18, #store)
  end)

  it("stores values the client marks secret as \"secret\" without reading them", function()
    local SECRET = setmetatable({}, { __tostring = function() error("a secret value was read") end })
    start({
      issecretvalue = function(v) return rawequal(v, SECRET) end,
      C_Spell = {
        GetSpellPowerCost = function() return { { type = 1, name = "POWER", cost = SECRET } } end,
      },
    })
    local _, r = run()
    assert.are.equal("secret", r["spells.sample"].value.spells[1].costs[1].cost)
    assert.are.equal("pass", r["api.issecretvalue"].status)
  end)

  it("leaks no globals beyond its SavedVariables", function()
    store = {}
    wow.install(full_api(store))
    local before = loader.global_keys()
    addon = loader.load(FILES, nil, wow)
    WF = addon.WF
    WF:Initialize()
    WF:Start()
    run()
    local added = loader.new_globals(before, loader.global_keys())
    assert.are.same({ "WayfinderCharData", "WayfinderData" }, added)
  end)

  it("stops and keeps a partial report when turned off mid-run", function()
    start()
    wow.set_profile_step(10) -- one probe per frame
    assert.is_true(WF:HandleSlash("selftest"))
    wow.next_frame()
    wow.next_frame()
    WF:SetEnabled("selftest", false)
    assert.is_false(WF.SelfTest.IsRunning())
    local report = rawget(_G, "WayfinderData").selftest
    assert.is_false(report.complete)
    assert.are.equal(2, #report.results)
    assert.is_true(wow.chat_contains("stopped early"))
  end)

  it("refuses a second run while one is in progress", function()
    start()
    assert.is_true(WF:HandleSlash("selftest"))
    assert.is_true(WF:HandleSlash("selftest"))
    assert.is_true(wow.chat_contains("already running"))
  end)
end)
