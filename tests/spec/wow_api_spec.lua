-- Specs for the WoW API stub itself (tests/wow-api/init.lua).

local wow = require("wow-api")

describe("wow-api stub", function()
  before_each(function() wow.install() end)
  after_each(function() wow.uninstall() end)

  describe("project detection", function()
    it("reports the Forever project id (18)", function()
      assert.are.equal(18, WOW_PROJECT_CAMELOT)
      assert.are.equal(WOW_PROJECT_CAMELOT, WOW_PROJECT_ID)
    end)

    it("accepts overrides to simulate another client", function()
      wow.install({ WOW_PROJECT_ID = 1 })
      assert.are_not.equal(WOW_PROJECT_CAMELOT, WOW_PROJECT_ID)
    end)
  end)

  describe("frames and events", function()
    it("delivers events only to registered frames, with self and payload", function()
      local seen = {}
      local a = CreateFrame("Frame")
      local b = CreateFrame("Frame")
      a:RegisterEvent("ADDON_LOADED")
      a:SetScript("OnEvent", function(self, event, name)
        seen[#seen + 1] = { self, event, name }
      end)
      b:SetScript("OnEvent", function() error("b is not registered") end)

      assert.are.equal(1, wow.fire_event("ADDON_LOADED", "Wayfinder"))
      assert.are.equal(1, #seen)
      assert.are.equal(a, seen[1][1])
      assert.are.equal("ADDON_LOADED", seen[1][2])
      assert.are.equal("Wayfinder", seen[1][3])
    end)

    it("stops delivering after UnregisterEvent / UnregisterAllEvents", function()
      local count = 0
      local f = CreateFrame("Frame")
      f:SetScript("OnEvent", function() count = count + 1 end)
      f:RegisterEvent("E1")
      f:RegisterEvent("E2")
      f:UnregisterEvent("E1")
      wow.fire_event("E1")
      assert.are.equal(0, count)
      assert.is_true(f:IsEventRegistered("E2"))
      f:UnregisterAllEvents()
      wow.fire_event("E2")
      assert.are.equal(0, count)
    end)

    it("counts frames and registrations (for 'off means no frames' tests)", function()
      assert.are.equal(0, #wow.frames())
      assert.are.equal(0, wow.registered_count())
      local f = CreateFrame("Frame")
      assert.are.equal(1, #wow.frames())
      assert.are.equal(0, wow.registered_count())
      f:RegisterEvent("PLAYER_LOGIN")
      assert.are.equal(1, wow.registered_count())
      assert.are.equal(1, wow.registered_count("PLAYER_LOGIN"))
      assert.are.equal(0, wow.registered_count("PLAYER_LOGOUT"))
    end)

    it("exposes named frames as globals and removes them on uninstall", function()
      local f = CreateFrame("Frame", "WayfinderSpecFrame", nil)
      assert.are.equal(f, rawget(_G, "WayfinderSpecFrame"))
      assert.are.equal("WayfinderSpecFrame", f:GetName())
      wow.uninstall()
      assert.is_nil(rawget(_G, "WayfinderSpecFrame"))
      assert.is_nil(rawget(_G, "CreateFrame"))
    end)

    it("tracks shown state", function()
      local f = CreateFrame("Frame")
      assert.is_true(f:IsShown())
      f:Hide()
      assert.is_false(f:IsShown())
    end)
  end)

  describe("time and C_Timer", function()
    it("runs timers only when the clock advances, in due order", function()
      local order = {}
      C_Timer.After(2, function() order[#order + 1] = "two" end)
      C_Timer.After(1, function() order[#order + 1] = "one" end)
      C_Timer.After(1, function() order[#order + 1] = "one-b" end)
      assert.are.equal(0, GetTime())
      wow.advance(0.5)
      assert.are.same({}, order)
      wow.advance(2)
      assert.are.same({ "one", "one-b", "two" }, order)
      assert.are.equal(2.5, GetTime())
    end)

    it("sets GetTime() inside a callback to the timer's due time", function()
      local at
      C_Timer.After(3, function() at = GetTime() end)
      wow.advance(10)
      assert.are.equal(3, at)
    end)

    it("does not run a cancelled NewTimer", function()
      local ran = false
      local t = C_Timer.NewTimer(1, function() ran = true end)
      t:Cancel()
      assert.is_true(t:IsCancelled())
      wow.advance(5)
      assert.is_false(ran)
    end)

    it("runs timers scheduled from inside a callback if they fall due", function()
      local ran = false
      C_Timer.After(1, function()
        C_Timer.After(1, function() ran = true end)
      end)
      wow.advance(1.5)
      assert.is_false(ran)
      wow.advance(1)
      assert.is_true(ran)
    end)
  end)

  describe("combat lockdown", function()
    it("toggles InCombatLockdown and fires PLAYER_REGEN_* events", function()
      local events = {}
      local f = CreateFrame("Frame")
      f:RegisterEvent("PLAYER_REGEN_DISABLED")
      f:RegisterEvent("PLAYER_REGEN_ENABLED")
      f:SetScript("OnEvent", function(_, event) events[#events + 1] = event end)

      assert.is_false(InCombatLockdown())
      wow.set_combat(true)
      assert.is_true(InCombatLockdown())
      wow.set_combat(true) -- no change, no second event
      wow.set_combat(false)
      assert.is_false(InCombatLockdown())
      assert.are.same({ "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED" }, events)
    end)
  end)

  describe("SavedVariables", function()
    it("sets globals before ADDON_LOADED and snapshots them on write", function()
      local disk = { WayfinderSpecDB = { version = 1, list = { "a" } } }
      local seenAtLoad
      local f = CreateFrame("Frame")
      f:RegisterEvent("ADDON_LOADED")
      f:SetScript("OnEvent", function(_, _, name)
        if name == "Wayfinder" then seenAtLoad = rawget(_G, "WayfinderSpecDB") end
      end)

      wow.load_saved_variables("Wayfinder", disk)
      assert.are.same(disk.WayfinderSpecDB, seenAtLoad)
      assert.are_not.equal(disk.WayfinderSpecDB, seenAtLoad) -- a copy, not the same table

      seenAtLoad.version = 2
      local written = wow.write_saved_variables({ "WayfinderSpecDB" })
      assert.are.equal(2, written.WayfinderSpecDB.version)
      assert.are.equal(1, disk.WayfinderSpecDB.version)

      wow.uninstall()
      assert.is_nil(rawget(_G, "WayfinderSpecDB"))
    end)
  end)
end)
