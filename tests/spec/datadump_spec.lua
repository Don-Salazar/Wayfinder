-- Specs for Modules/DataDump.lua (/wf dump). The API set below is synthetic:
-- every ID, name and number is a placeholder, not game data.

local wow = require("wow-api")
local loader = require("support.addon_loader")

local FILES = { "Modules/Core.lua", "Modules/DataDump.lua" }
local CHARACTER_NAME = "Zzcharname"
local REALM_NAME = "Zzrealmname"
local GUID = "Creature-0-1234-5678-90-4242-0000ABCDEF"

local function link(id, name)
  return ("|cffffffff|Hitem:%d::::::::1:::::::|h[%s]|h|r"):format(id, name)
end

local ZONE_EVENTS = { "ZONE_CHANGED_NEW_AREA", "ZONE_CHANGED", "ZONE_CHANGED_INDOORS", "PLAYER_ENTERING_WORLD" }

-- world: mutable state the stubs read (current zone, trainer filters).
local function full_api(world)
  local spellbook = {
    { spellID = 11, name = "Spell A", subName = "Rank 1", itemType = 1, isPassive = false, skillLineIndex = 2 },
    { spellID = 12, name = "Trait", subName = "Racial Passive", itemType = 1, isPassive = true, skillLineIndex = 1 },
    { spellID = 13, name = "Spell B", subName = "Rank 2", itemType = 2, isPassive = false, skillLineIndex = 2 },
  }
  local spellNames = { [11] = "Spell A", [12] = "Trait", [13] = "Spell B", [77] = "Seeded" }
  local items = {
    [101] = { "Item A", link(101, "Item A"), 2, 10, 5, "Armor", "Mail", 1, "INVTYPE_CHEST", "tex", 100, 4, 3 },
    [102] = { "Item B", link(102, "Item B"), 1, 3, 1, "Misc", "Junk", 20, "", "tex", 1, 15, 0 },
  }
  local function item_info(arg)
    local id = type(arg) == "number" and arg or tonumber(tostring(arg):match("item:(%d+)"))
    local row = items[id]
    if row then return unpack(row, 1, 13) end
  end
  local services = {
    { "Spell A", "Rank 1", "used", false },
    { "Spell C", "Rank 1", "unavailable", false },
  }
  return {
    GetBuildInfo = function() return "0.0.0", "0", "Jan 1 2000", 16001 end,
    GetLocale = function() return "enUS" end,
    GetServerTime = function() return 1000 end,
    UnitName = function() return CHARACTER_NAME, REALM_NAME end,
    GetRealmName = function() return REALM_NAME end,
    UnitClass = function() return "Class", "CLASS", 1 end,
    UnitRace = function() return "Race", "RACE", 2 end,
    UnitLevel = function() return 7 end,
    UnitFactionGroup = function() return "Faction", "Faction" end,
    UnitStat = function(_, index) return 20 + index, 22 + index, 2, 0 end,
    UnitArmor = function() return 50, 60 end,
    UnitHealthMax = function() return 100 end,
    UnitPowerMax = function() return 100 end,
    UnitGUID = function(unit) if unit == "npc" then return GUID end end,
    UnitPosition = function() return 1, 2, 0, 0 end,
    GetInstanceInfo = function() return "World", "none", 0, "", 0, 0, false, 0 end,
    GetZoneText = function() return world.zone end,
    GetRealZoneText = function() return world.zone end,
    GetSubZoneText = function() return world.subzone end,
    C_Map = {
      GetBestMapForUnit = function() return world.map end,
      GetMapInfo = function(id) return { name = "Map " .. id, mapType = 3, parentMapID = 1 } end,
      GetPlayerMapPosition = function()
        return { GetXY = function() return 0.42314, 0.67891 end }
      end,
    },
    Enum = {
      SpellBookSpellBank = { Player = 0 },
      SpellBookItemType = { Spell = 1, FutureSpell = 2, Flyout = 3 },
    },
    C_SpellBook = {
      GetSpellBookItemInfo = function(index) return spellbook[index] end,
    },
    C_Spell = {
      GetSpellInfo = function(id)
        if spellNames[id] then return { name = spellNames[id], castTime = 1500, minRange = 0, maxRange = 5 } end
      end,
      GetSpellPowerCost = function() return { { type = 1, name = "RAGE", cost = 10, minCost = 10 } } end,
      GetSpellSubtext = function() return "Rank 1" end,
      IsSpellDataCached = function(id) return spellNames[id] ~= nil end,
      RequestLoadSpellData = function() end,
    },
    C_TooltipInfo = {
      GetSpellByID = function(id)
        return { lines = { { leftText = spellNames[id] or "?", rightText = "Rank 1" }, { leftText = "10 Rage" } } }
      end,
      GetInventoryItem = function() return { lines = { { leftText = "Item A" } } } end,
      GetBagItem = function() return { lines = { { leftText = "Item B" } } } end,
      GetItemByID = function() return { lines = { { leftText = "Seed item" } } } end,
    },
    GetNumTalentTabs = function() return 2 end,
    GetTalentTabInfo = function(tab) return "Tree " .. tab, "icon", 0 end,
    GetNumTalents = function() return 2 end,
    GetTalentInfo = function(tab, index) return "Talent " .. tab .. index, "icon", index, 1, 0, 5 end,
    GetTalentPrereqs = function(_, index) if index == 2 then return 1, 1, true end end,
    C_QuestLog = {
      GetNumQuestLogEntries = function() return 2, 1 end,
      GetInfo = function(index)
        if index == 1 then return { isHeader = true, title = "Header" } end
        return { questID = 501, title = "Quest", level = 5, suggestedGroup = 0 }
      end,
      GetQuestObjectives = function()
        return { { text = "0/8 Things", type = "monster", numRequired = 8, numFulfilled = 0, finished = false } }
      end,
      SetSelectedQuest = function() end,
    },
    GetNumQuestLogChoices = function() return 1 end,
    GetQuestLogChoiceInfo = function() return "Choice", "tex", 1, 2, true end,
    GetQuestLogItemLink = function(kind, index)
      if kind == "choice" and index == 1 then return link(201, "Choice") end
      if kind == "reward" and index == 1 then return link(202, "Reward") end
    end,
    GetInventoryItemLink = function(_, slot) if slot == 16 then return link(101, "Item A") end end,
    GetInventoryItemID = function(_, slot) if slot == 16 then return 101 end end,
    C_Container = {
      GetContainerNumSlots = function(bag) return bag == 0 and 2 or 0 end,
      GetContainerItemLink = function(bag, slot) if bag == 0 and slot == 2 then return link(102, "Item B") end end,
      GetContainerItemInfo = function() return { stackCount = 3 } end,
    },
    C_Item = {
      GetItemInfo = item_info,
      GetItemStats = function() return { ITEM_MOD_STAMINA_SHORT = 3 } end,
    },
    GetNumTrainerServices = function() return #services end,
    GetTrainerServiceInfo = function(index) return unpack(services[index]) end,
    GetTrainerServiceCost = function(index) return 100 * index end,
    GetTrainerServiceLevelReq = function(index) return 4 * index end,
    GetTrainerServiceSkillLine = function() return "Line" end,
    GetTrainerServiceTypeFilter = function(filter) return world.filters[filter] end,
    IsTradeskillTrainer = function() return false end,
  }
end

local function new_world()
  return { map = 10, zone = "Zone", subzone = "Sub", filters = { available = 1, unavailable = 1, used = 1 } }
end

-- Is `value` plain data? Returns false and a path on failure.
local function serializable(value, path)
  path = path or "dump"
  local kind = type(value)
  if kind == "string" or kind == "number" or kind == "boolean" then return true end
  if kind ~= "table" then return false, path .. " is a " .. kind end
  if getmetatable(value) ~= nil then return false, path .. " has a metatable" end
  for k, v in pairs(value) do
    if type(k) ~= "string" and type(k) ~= "number" then return false, path .. " has a " .. type(k) .. " key" end
    local ok, where = serializable(v, path .. "." .. tostring(k))
    if not ok then return false, where end
  end
  return true
end

-- Every string key and value in `value`, joined (for "never appears" checks).
local function all_text(value, out)
  out = out or {}
  if type(value) == "table" then
    for k, v in pairs(value) do
      out[#out + 1] = tostring(k)
      all_text(v, out)
    end
  else
    out[#out + 1] = tostring(value)
  end
  return table.concat(out, "\n")
end

local function by(list, field, value)
  for _, entry in ipairs(list) do
    if entry[field] == value then return entry end
  end
end

describe("Modules/DataDump.lua", function()
  local addon, WF, world

  local function start(overrides, metadata, bare)
    world = new_world()
    local api = bare and {} or full_api(world)
    for k, v in pairs(overrides or {}) do api[k] = v end
    wow.install(api)
    if metadata then wow.set_metadata(metadata) end
    addon = loader.load(FILES, nil, wow)
    WF = addon.WF
    WF:Initialize()
    WF:Start()
  end

  local function drain()
    for _ = 1, 3000 do
      if not WF.DataDump.IsRunning() and wow.pending_timers() == 0 then return end
      wow.next_frame()
    end
    error("dump did not finish")
  end

  local function run(command)
    assert.is_true(WF:HandleSlash(command or "dump"))
    drain()
    local dump = rawget(_G, "WayfinderData").dump
    assert.is_table(dump)
    return dump
  end

  after_each(function() wow.uninstall() end)

  it("is off in release builds: no frames, no events, no dump", function()
    start(nil, { Version = "1.0.0" })
    assert.is_false(WF:IsEnabled("dump"))
    assert.are.equal(0, #wow.frames())
    assert.are.equal(0, wow.registered_count())
    assert.is_true(WF:HandleSlash("dump"))
    assert.is_true(wow.chat_contains("Data dump is off"))
    assert.are.equal(0, wow.pending_timers())
    assert.is_nil(rawget(_G, "WayfinderData").dump)
  end)

  it("when on and idle registers only the zone and trainer events, on one frame", function()
    start()
    assert.is_true(WF:IsEnabled("dump"))
    assert.are.equal(1, #wow.frames())
    assert.are.equal(1, wow.registered_count())
    local expected = { TRAINER_SHOW = true, TRAINER_CLOSED = true }
    for _, event in ipairs(ZONE_EVENTS) do expected[event] = true end
    assert.are.same(expected, wow.frames()[1]._events)
    assert.are.equal(0, wow.pending_timers())
    WF:SetEnabled("dump", false)
    assert.are.equal(0, wow.registered_count())
  end)

  it("writes a full dump of plain data with the expected fields", function()
    start()
    local dump = run()
    local ok, where = serializable(dump)
    assert.is_true(ok, where)
    local meta = dump.meta
    assert.is_true(meta.complete)
    assert.are.equal(16001, meta.interface)
    assert.are.equal("CLASS", meta.class)
    assert.are.equal("RACE", meta.race)
    assert.are.equal(7, meta.level)
    assert.are.equal("Faction", meta.faction)
    assert.are.equal("enUS", meta.locale)
    assert.is_string(meta.time)
    for _, name in ipairs({ "stats", "spells", "racials", "talents", "quests", "items", "maps" }) do
      assert.are.equal("ok", meta.sections[name].status, name)
      assert.is_string(meta.sections[name].path, name)
    end
    assert.are.equal("C_SpellBook.GetSpellBookItemInfo", meta.sections.spells.path)

    -- spells: every spellbook slot, costs and tooltip lines
    assert.are.equal(3, #dump.spells)
    local a = by(dump.spells, "id", 11)
    assert.are.equal("Spell A", a.name)
    assert.are.equal("Rank 1", a.subtext)
    assert.are.equal("Spell", a.kind)
    assert.are.equal(2, a.tab)
    assert.are.equal(1500, a.castTime)
    assert.are.equal(5, a.maxRange)
    assert.are.same({ type = 1, name = "RAGE", cost = 10, minCost = 10 }, a.costs[1])
    assert.are.same({ { l = "Spell A", r = "Rank 1" }, { l = "10 Rage" } }, a.tooltip)
    assert.are.equal("C_TooltipInfo.GetSpellByID", a.tooltipPath)
    assert.is_true(by(dump.spells, "id", 13).future)

    -- racials: found by subtext, with tooltip
    assert.are.equal(1, #dump.racials)
    assert.are.equal(12, dump.racials[1].id)
    assert.are.equal("Trait", dump.racials[1].tooltip[1].l)

    -- talents: all trees, tier/column/ranks, prerequisites
    assert.are.equal(4, #dump.talents)
    local t = dump.talents[2]
    assert.are.same({ 1, 2 }, { t.tab, t.index })
    assert.are.equal("Tree 1", t.tabName)
    assert.are.equal("Talent 12", t.name)
    assert.are.same({ 2, 1, 0, 5 }, { t.tier, t.column, t.rank, t.maxRank })
    assert.are.same({ { tier = 1, column = 1, learnable = true } }, t.prereqs)

    -- quests: header skipped; objectives, choices, rewards
    assert.are.equal(1, #dump.quests)
    local q = dump.quests[1]
    assert.are.same({ 501, "Quest", 5 }, { q.questID, q.title, q.level })
    assert.are.same({ text = "0/8 Things", type = "monster", numRequired = 8, numFulfilled = 0, finished = false },
      q.objectives[1])
    assert.are.equal(201, q.choices[1].itemID)
    assert.are.equal(1, q.choices[1].count)
    assert.are.same({ { itemID = 202, name = "Reward" } }, q.rewards)

    -- items: equipped and bag, with info, stats, tooltip
    assert.are.equal(2, #dump.items)
    local eq = by(dump.items, "source", "equipped")
    assert.are.same({ 16, 101, "Item A", 2, 10, 5, "INVTYPE_CHEST" },
      { eq.slot, eq.itemID, eq.name, eq.quality, eq.itemLevel, eq.requiredLevel, eq.equipSlot })
    assert.are.same({ ITEM_MOD_STAMINA_SHORT = 3 }, eq.stats)
    assert.are.equal("Item A", eq.tooltip[1].l)
    local bag = by(dump.items, "source", "bag")
    assert.are.same({ 0, 2, 102, 3 }, { bag.bag, bag.slot, bag.itemID, bag.count })

    -- stats: base and effective, equipment occupancy
    assert.are.same({ index = 1, base = 21, effective = 23 }, dump.stats.primary[1])
    assert.are.same({ base = 50, effective = 60 }, dump.stats.armor)
    assert.are.equal(100, dump.stats.healthMax)
    assert.are.same({ 16 }, dump.stats.equippedSlots)
    assert.is_false(dump.stats.naked)

    -- maps: the current zone
    assert.are.equal(1, #dump.maps)
    assert.are.same({ 10, "Map 10", "Zone", "Sub", 0 },
      { dump.maps[1].uiMapID, dump.maps[1].mapName, dump.maps[1].zoneText, dump.maps[1].subZoneText,
        dump.maps[1].instanceID })

    assert.is_true(wow.chat_contains("dump complete"))
    assert.is_true(wow.chat_contains("/reload to save"))
    assert.are.equal(0, #WF.errors)
  end)

  it("runs across several frames and prints progress", function()
    start()
    wow.set_profile_step(10) -- every step costs the whole frame budget
    assert.is_true(WF:HandleSlash("dump"))
    local frames = 0
    while WF.DataDump.IsRunning() and frames < 3000 do
      wow.set_time(GetTime() + 0.5) -- slow frames, so progress lines fall due
      wow.next_frame()
      frames = frames + 1
    end
    assert.is_true(frames > 10)
    assert.is_true(wow.chat_contains("dump: "))
  end)

  it("dumps one section on its own and keeps the others", function()
    start()
    run()
    local dump = run("dump talents")
    assert.are.equal(4, #dump.talents)
    assert.are.equal(3, #dump.spells)
    assert.is_true(wow.chat_contains("dump talents complete"))
  end)

  it("marks missing APIs as missing and never errors", function()
    start(nil, nil, true)
    local dump = run()
    for _, name in ipairs({ "stats", "spells", "racials", "talents", "quests", "items" }) do
      assert.are.equal("missing", dump.meta.sections[name].status, name)
    end
    local ok, where = serializable(dump)
    assert.is_true(ok, where)
    assert.are.equal(0, #WF.errors)
    assert.are.equal(0, #wow.errors())
  end)

  it("stores secret values as \"secret\" and never touches them", function()
    local touched = function() error("a secret value was read") end
    local SECRET = setmetatable({}, {
      __index = touched, __newindex = touched, __tostring = touched, __concat = touched,
      __lt = touched, __le = touched, __len = touched, __call = touched,
    })
    world = new_world()
    local api = full_api(world)
    api.issecretvalue = function(v) return rawequal(v, SECRET) end
    api.C_Spell.GetSpellPowerCost = function() return { { type = 1, name = "RAGE", cost = SECRET } } end
    api.C_TooltipInfo.GetSpellByID = function() return { lines = { { leftText = SECRET } } } end
    api.UnitHealthMax = function() return SECRET end
    api.UnitStat = function() return SECRET, SECRET end
    api.GetZoneText = function() return SECRET end
    api.C_Item.GetItemStats = function() return SECRET end
    start(api)
    local dump = run()
    local a = by(dump.spells, "id", 11)
    assert.are.equal("secret", a.costs[1].cost)
    assert.are.equal("secret", a.tooltip[1].l)
    assert.are.equal("secret", dump.stats.healthMax)
    assert.are.equal("secret", dump.stats.primary[1].base)
    assert.are.equal("secret", dump.maps[1].zoneText)
    assert.are.equal("secret", by(dump.items, "source", "equipped").stats)
    local ok, where = serializable(dump)
    assert.is_true(ok, where)
    assert.are.equal(0, #WF.errors)
  end)

  it("parses only the creature ID from a GUID", function()
    start()
    local parse = WF.DataDump.ParseCreatureId
    assert.are.equal(4242, parse(GUID))
    assert.are.equal(77, parse("Vehicle-0-1-2-3-77-00FF"))
    assert.is_nil(parse("Player-1234-0ABCDEF0"))
    assert.is_nil(parse("Creature-0-1-2-3-x-00FF"))
    assert.is_nil(parse(nil))
  end)

  it("dumps an open trainer window on TRAINER_SHOW, keyed by creature ID only", function()
    start()
    wow.fire_event("TRAINER_SHOW")
    drain()
    local dump = rawget(_G, "WayfinderData").dump
    local record = dump.trainer["4242"]
    assert.is_table(record)
    assert.are.equal(4242, record.npcId)
    assert.are.same({ 10, 42.3, 67.9 }, { record.uiMapID, record.x, record.y })
    assert.are.same({ available = 1, unavailable = 1, used = 1 }, record.filters)
    assert.are.equal(2, #record.services)
    local s = record.services[1]
    assert.are.same({ "Spell A", "Rank 1", "used", 100, 4, "Line" },
      { s.name, s.rank, s.category, s.cost, s.levelReq, s.skillLine })
    assert.are.equal("unavailable", record.services[2].category)
    local text = all_text(dump.trainer)
    assert.is_nil(text:find("1234", 1, true))
    assert.is_nil(text:find("0000ABCDEF", 1, true))
    assert.is_nil(text:find(GUID, 1, true))
    assert.is_false(wow.chat_contains("Tick all filters"))
    -- a later full dump links the service to the spellbook spell by exact name and rank
    dump = run()
    assert.are.equal(11, dump.trainer["4242"].services[1].spellId)
    assert.is_nil(dump.trainer["4242"].services[2].spellId)
  end)

  it("tells the player once to tick all trainer filters when one is off", function()
    start()
    world.filters.used = nil
    wow.fire_event("TRAINER_SHOW")
    drain()
    assert.is_true(wow.chat_contains("Tick all filters"))
    local record = rawget(_G, "WayfinderData").dump.trainer["4242"]
    assert.is_false(record.filters.used)
    assert.are.equal(1, record.filters.available)
  end)

  it("refuses /wf dump trainer with no trainer open", function()
    start({ GetNumTrainerServices = function() return 0 end })
    assert.is_true(WF:HandleSlash("dump trainer"))
    drain()
    assert.is_true(wow.chat_contains("no trainer window is open"))
  end)

  it("records zone rows from events, de-duplicated", function()
    start()
    wow.fire_event("PLAYER_ENTERING_WORLD")
    wow.fire_event("ZONE_CHANGED")
    local maps = rawget(_G, "WayfinderData").dump.maps
    assert.are.equal(1, #maps)
    assert.are.equal(2, maps[1].seen)
    world.subzone = "Other"
    wow.fire_event("ZONE_CHANGED")
    world.map, world.zone, world.subzone = 11, "Zone 2", ""
    wow.fire_event("ZONE_CHANGED_NEW_AREA")
    wow.fire_event("ZONE_CHANGED_INDOORS")
    assert.are.equal(3, #maps)
    assert.are.same({ 11, "Map 11", 3, 1 }, { maps[3].uiMapID, maps[3].mapName, maps[3].mapType, maps[3].parentMapID })
    assert.are.equal(0, wow.pending_timers())
  end)

  it("refuses a second dump while one runs", function()
    start()
    assert.is_true(WF:HandleSlash("dump"))
    assert.is_true(WF:HandleSlash("dump"))
    assert.is_true(wow.chat_contains("already running"))
    drain()
  end)

  it("stops cleanly when turned off mid-run", function()
    start()
    wow.set_profile_step(10)
    assert.is_true(WF:HandleSlash("dump"))
    wow.next_frame()
    wow.next_frame()
    WF:SetEnabled("dump", false)
    assert.is_false(WF.DataDump.IsRunning())
    assert.is_true(wow.chat_contains("stopped early"))
    for _ = 1, 400 do wow.next_frame() end
    assert.are.equal(0, wow.pending_timers())
    assert.are.equal(0, wow.registered_count())
  end)

  it("reads development seeds: extra spells and items, uncached items marked", function()
    start()
    WF.dumpSeeds = { items = { 102, 999, "x" }, spells = { 11, 77, 0 } }
    local dump = run()
    local seeded = by(dump.spells, "source", "seed")
    assert.are.equal(77, seeded.id)
    assert.are.equal("Seeded", seeded.name)
    assert.are.same({ type = 1, name = "RAGE", cost = 10, minCost = 10 }, seeded.costs[1])
    local count11 = 0
    for _, spell in ipairs(dump.spells) do if spell.id == 11 then count11 = count11 + 1 end end
    assert.are.equal(1, count11)
    local seedItems = {}
    for _, item in ipairs(dump.items) do if item.source == "seed" then seedItems[item.itemID] = item end end
    assert.is_true(seedItems[102].cached)
    assert.are.equal("Seed item", seedItems[102].tooltip[1].l)
    assert.is_false(seedItems[999].cached)
    assert.are.same({ items = 2, spells = 2 }, dump.meta.seeds)
  end)

  it("status and clear", function()
    start()
    run()
    assert.is_true(WF:HandleSlash("dump status"))
    assert.is_true(wow.chat_contains("spells: ok, 3 entries"))
    assert.is_true(WF:HandleSlash("dump clear"))
    assert.is_nil(rawget(_G, "WayfinderData").dump)
    assert.is_true(WF:HandleSlash("dump bogus"))
    assert.is_true(wow.chat_contains("usage: /wf dump"))
  end)

  it("never writes the character or realm name", function()
    start()
    wow.fire_event("TRAINER_SHOW")
    drain()
    local dump = run()
    local text = all_text(dump)
    assert.is_nil(text:find(CHARACTER_NAME, 1, true))
    assert.is_nil(text:find(REALM_NAME, 1, true))
  end)

  it("leaks no globals beyond its SavedVariables", function()
    world = new_world()
    wow.install(full_api(world))
    local before = loader.global_keys()
    addon = loader.load(FILES, nil, wow)
    WF = addon.WF
    WF:Initialize()
    WF:Start()
    run()
    local added = loader.new_globals(before, loader.global_keys())
    assert.are.same({ "WayfinderCharData", "WayfinderData" }, added)
  end)
end)
