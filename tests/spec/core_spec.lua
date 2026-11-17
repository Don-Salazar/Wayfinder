-- Specs for Modules/Core.lua (addon.WF): module registry, toggles, slash
-- routing, guarded calls and the frame-budget scheduler.

local wow = require("wow-api")
local loader = require("support.addon_loader")

local CORE = { "Modules/Core.lua" }

-- A module definition whose OnEnable creates a frame and registers an event,
-- and whose OnDisable undoes both. `calls` counts the lifecycle calls.
local function test_module(overrides)
  local def = { title = "Test module", desc = "For specs.", default = false }
  local calls = { enable = 0, disable = 0, slash = {} }
  function def.OnEnable()
    calls.enable = calls.enable + 1
    def.frame = def.frame or CreateFrame("Frame")
    def.frame:RegisterEvent("PLAYER_LOGIN")
  end
  function def.OnDisable()
    calls.disable = calls.disable + 1
    if def.frame then
      def.frame:UnregisterAllEvents()
      def.frame:Hide()
    end
  end
  def.slash = {
    probe = function(args) calls.slash[#calls.slash + 1] = args end,
  }
  for k, v in pairs(overrides or {}) do def[k] = v end
  return def, calls
end

describe("Modules/Core.lua", function()
  local addon, WF

  local function load_core(savedVariables)
    addon = loader.load(CORE, nil, wow)
    WF = addon.WF
    if savedVariables then wow.load_saved_variables(loader.ADDON_NAME, savedVariables) end
  end

  before_each(function() wow.install() end)
  after_each(function() wow.uninstall() end)

  describe("loading", function()
    it("creates no globals, frames or events at file load", function()
      local before = loader.global_keys()
      load_core()
      assert.are.same({}, loader.new_globals(before, loader.global_keys()))
      assert.is_table(addon.WF)
      assert.are.equal(0, #wow.frames())
    end)

    it("creates only its two SavedVariables when initialised", function()
      local before = loader.global_keys()
      load_core()
      WF:Initialize()
      WF:Start()
      local added = loader.new_globals(before, loader.global_keys())
      assert.are.same({ "WayfinderCharData", "WayfinderData" }, added)
      assert.are.same({}, rawget(_G, "WayfinderData").toggles)
      assert.are.equal(WF.db, rawget(_G, "WayfinderData"))
      assert.are.equal(WF.charDb, rawget(_G, "WayfinderCharData"))
    end)

    it("keeps saved data that is already there", function()
      load_core({ WayfinderData = { toggles = { x = true }, selftest = { version = "old" } } })
      WF:Initialize()
      assert.are.equal("old", WF.db.selftest.version)
      assert.is_true(WF.db.toggles.x)
    end)

    it("wires into the AceAddon lifecycle when addon:NewModule exists", function()
      local created = {}
      local fake = {}
      function fake.NewModule(_, name)
        local m = { name = name }
        created[#created + 1] = m
        return m
      end
      loader.load(CORE, fake, wow)
      assert.are.equal(1, #created)
      assert.are.equal("WayfinderCore", created[1].name)
      created[1].OnInitialize()
      assert.is_true(fake.WF.initialized)
      created[1].OnEnable()
      assert.is_true(fake.WF.started)
    end)
  end)

  describe("development vs release", function()
    it("reads the TOC version", function()
      load_core()
      assert.are.equal("0.1.0-dev", WF.version)
      assert.is_true(WF.isDevelopment)
    end)

    it("classifies version strings", function()
      load_core()
      assert.is_true(WF.IsDevelopmentVersion("0.3.1"))
      assert.is_true(WF.IsDevelopmentVersion("1.2.0-dev"))
      assert.is_true(WF.IsDevelopmentVersion("1.2.0-DEV.3"))
      assert.is_false(WF.IsDevelopmentVersion("1.0.0"))
      assert.is_false(WF.IsDevelopmentVersion("10.1"))
      assert.is_false(WF.IsDevelopmentVersion(nil))
      assert.is_true(WF.IsDevelopmentVersion("@project-version@"))
    end)

    it("uses devDefault only in development builds", function()
      load_core()
      local def = test_module({ default = false, devDefault = true })
      WF:RegisterModule("dev", def)
      assert.is_true(WF:GetDefault("dev"))

      wow.uninstall()
      wow.install()
      wow.set_metadata({ Version = "1.0.0" })
      load_core()
      WF:RegisterModule("dev", test_module({ default = false, devDefault = true }))
      assert.is_false(WF.isDevelopment)
      assert.is_false(WF:GetDefault("dev"))
    end)
  end)

  describe("module toggles", function()
    it("never enables a module that is off: no OnEnable, no frames, no events", function()
      load_core()
      local def, calls = test_module({ default = false })
      WF:RegisterModule("test", def)
      WF:Initialize()
      WF:Start()
      assert.are.equal(0, calls.enable)
      assert.are.equal(0, #wow.frames())
      assert.are.equal(0, wow.registered_count())
      assert.is_false(WF:IsEnabled("test"))
    end)

    it("enables a default-on module at start and toggles it at once", function()
      load_core()
      local def, calls = test_module({ default = true })
      WF:RegisterModule("test", def)
      WF:Initialize()
      assert.are.equal(0, calls.enable) -- nothing before login
      WF:Start()
      assert.are.equal(1, calls.enable)
      assert.are.equal(1, wow.registered_count("PLAYER_LOGIN"))

      WF:SetEnabled("test", false)
      assert.are.equal(1, calls.disable)
      assert.are.equal(0, wow.registered_count())
      assert.is_false(WF.db.toggles.test)
      assert.is_false(WF:IsEnabled("test"))

      WF:SetEnabled("test", false) -- no change, no second OnDisable
      assert.are.equal(1, calls.disable)

      WF:SetEnabled("test", true)
      assert.are.equal(2, calls.enable)
      assert.is_true(WF.db.toggles.test)
    end)

    it("lets a saved toggle win over the default", function()
      load_core({ WayfinderData = { toggles = { test = true } } })
      local def, calls = test_module({ default = false })
      WF:RegisterModule("test", def)
      WF:Initialize()
      WF:Start()
      assert.are.equal(1, calls.enable)
    end)

    it("enables a module registered after start", function()
      load_core()
      WF:Initialize()
      WF:Start()
      local def, calls = test_module({ default = true })
      WF:RegisterModule("late", def)
      assert.are.equal(1, calls.enable)
    end)

    it("rolls back a module whose OnEnable throws", function()
      load_core()
      local def, calls = test_module({ default = true })
      def.OnEnable = function() error("enable failed") end
      WF:RegisterModule("bad", def)
      WF:Start()
      assert.is_false(WF:IsEnabled("bad"))
      assert.are.equal(1, calls.disable)
      assert.are.equal(1, #WF.errors)
      assert.are.equal("bad", WF.errors[1].module)
      assert.are.equal(1, #wow.errors())
    end)

    it("keeps the right failure message when errors are de-duplicated or capped", function()
      load_core()
      WF:Start()
      local a = WF:RegisterModule("a", test_module({ default = true, slash = {},
        OnEnable = function() error("A broke") end }))
      WF:RegisterModule("b", test_module({ default = true, slash = {},
        OnEnable = function() error("B broke") end }))
      assert.truthy(a.failed:find("A broke", 1, true))
      WF:SetEnabled("a", true) -- de-duplicated into A's older record
      assert.truthy(a.failed:find("A broke", 1, true))
      for i = 1, 60 do WF:Guard("x", function() error("filler " .. i) end)() end
      local c = WF:RegisterModule("c", test_module({ default = true, slash = {},
        OnEnable = function() error("C broke") end }))
      assert.truthy(c.failed:find("C broke", 1, true)) -- cap hit: no record, message kept
    end)

    it("reserves upstream's subcommands", function()
      load_core()
      for _, name in ipairs({ "debug", "splits", "show", "hide", "toggle", "bug", "feedback", "preview", "help" }) do
        assert.has_error(function()
          WF:RegisterModule("m_" .. name, test_module({ slash = { [name] = function() end } }))
        end, nil, name)
      end
    end)

    it("rejects bad definitions and duplicate ids or subcommands", function()
      load_core()
      assert.has_error(function() WF:RegisterModule("x", { title = "X" }) end)
      assert.has_error(function() WF:RegisterModule("core", test_module()) end)
      assert.has_error(function() WF:RegisterModule("two words", test_module()) end)
      WF:RegisterModule("a", test_module())
      assert.has_error(function() WF:RegisterModule("a", test_module()) end)
      assert.has_error(function() WF:RegisterModule("b", test_module()) end) -- "probe" is taken
      assert.has_error(function()
        WF:RegisterModule("c", test_module({ slash = { modules = function() end } }))
      end)
    end)
  end)

  describe("options page", function()
    it("lists every module with a toggle that applies at once", function()
      load_core()
      local def, calls = test_module({ default = false })
      WF:RegisterModule("test", def)
      WF:Initialize()
      WF:Start()
      local options = WF:BuildOptionsTable()
      local toggle = options.args.test
      assert.are.equal("toggle", toggle.type)
      assert.are.equal("Test module", toggle.name)
      assert.are.equal("For specs.", options.args.test_desc.name)
      assert.is_false(toggle.get())
      toggle.set(nil, true)
      assert.are.equal(1, calls.enable)
      assert.is_true(toggle.get())
    end)

    it("registers under the addon's options category when it exists", function()
      local registered, added = {}, {}
      local libs = {
        ["AceConfig-3.0"] = {
          RegisterOptionsTable = function(_, app, options) registered[app] = options end,
        },
        ["AceConfigDialog-3.0"] = {
          BlizOptionsIDMap = { Wayfinder = 1 },
          AddToBlizOptions = function(_, app, name, parent) added[#added + 1] = { app, name, parent } end,
        },
      }
      wow.install({ LibStub = setmetatable({}, { __call = function(_, name) return libs[name] end }) })
      load_core()
      addon.title = "Wayfinder"
      WF:Initialize()
      assert.is_function(registered["Wayfinder modules"])
      assert.are.same({ { "Wayfinder modules", "Wayfinder modules", "Wayfinder" } }, added)

      -- Parent not registered (upstream panel failed): top level, no error.
      libs["AceConfigDialog-3.0"].BlizOptionsIDMap = {}
      added = {}
      load_core()
      addon.title = "Wayfinder"
      WF:Initialize()
      assert.are.same({ { "Wayfinder modules", "Wayfinder modules" } }, added)
      assert.are.equal(0, #wow.errors())
    end)
  end)

  describe("slash routing", function()
    it("claims /wf modules and lists the modules", function()
      load_core()
      WF:RegisterModule("test", test_module())
      WF:Initialize()
      WF:Start()
      assert.is_true(WF:HandleSlash("modules"))
      assert.is_true(wow.chat_contains("test - Test module: off"))
    end)

    it("leaves upstream's subcommands and empty input to upstream", function()
      load_core()
      WF:Initialize()
      assert.is_false(WF:HandleSlash(""))
      assert.is_false(WF:HandleSlash("debug"))
      assert.is_false(WF:HandleSlash(nil))
    end)

    it("routes a module's subcommand with its arguments, case-insensitively", function()
      load_core()
      local def, calls = test_module({ default = true })
      WF:RegisterModule("test", def)
      WF:Initialize()
      WF:Start()
      assert.is_true(WF:HandleSlash("  PROBE  one two "))
      assert.are.same({ "one two" }, calls.slash)
    end)

    it("does not run a disabled module's subcommand, and says how to turn it on", function()
      load_core()
      local def, calls = test_module({ default = false })
      WF:RegisterModule("test", def)
      WF:Initialize()
      WF:Start()
      assert.is_true(WF:HandleSlash("probe"))
      assert.are.same({}, calls.slash)
      assert.is_true(wow.chat_contains("/wf modules test on"))
    end)

    it("toggles a module with /wf modules <id> on|off", function()
      load_core()
      local def, calls = test_module({ default = false })
      WF:RegisterModule("test", def)
      WF:Initialize()
      WF:Start()
      assert.is_true(WF:HandleSlash("modules test on"))
      assert.are.equal(1, calls.enable)
      assert.is_true(WF:HandleSlash("modules test off"))
      assert.are.equal(1, calls.disable)
      assert.is_true(WF:HandleSlash("modules nope on"))
      assert.is_true(wow.chat_contains("no module 'nope'"))
    end)

    it("records an error in a subcommand handler and still claims it", function()
      load_core()
      local def = test_module({ default = true })
      def.slash = { probe = function() error("handler broke") end }
      WF:RegisterModule("test", def)
      WF:Start()
      assert.is_true(WF:HandleSlash("probe"))
      assert.are.equal(1, #WF.errors)
      assert.truthy(WF.errors[1].message:find("handler broke", 1, true))
    end)

    it("claims a matched subcommand even when its output itself fails", function()
      load_core()
      WF:RegisterModule("test", test_module({ default = false }))
      WF:Start()
      wow.install({ DEFAULT_CHAT_FRAME = { AddMessage = function() error("chat broke") end } })
      assert.is_true(WF:HandleSlash("probe"))
      assert.is_true(WF:HandleSlash("modules"))
      assert.is_false(WF:HandleSlash("debug"))
    end)
  end)

  describe("Guard", function()
    it("returns the wrapped function's results", function()
      load_core()
      local f = WF:Guard("test", function(a, b) return a + b, "x", nil end)
      local sum, x, z = f(2, 3)
      assert.are.equal(5, sum)
      assert.are.equal("x", x)
      assert.is_nil(z)
      assert.are.equal(0, #WF.errors)
    end)

    it("records message, stack, module and count, and re-raises to the error handler", function()
      load_core()
      local f = WF:Guard("test", function() error("boom") end)
      assert.is_nil(f())
      f()
      assert.are.equal(1, #WF:GetErrors())
      local record = WF.errors[1]
      assert.truthy(record.message:find("boom", 1, true))
      assert.is_string(record.stack)
      assert.are.equal("test", record.module)
      assert.are.equal(2, record.count)
      assert.are.equal(2, #wow.errors())
      assert.truthy(wow.errors()[1]:find("boom", 1, true))
      assert.truthy(wow.errors()[1]:find("\n", 1, true), "stack passed to the error handler")
    end)

    it("caps the number of distinct records", function()
      load_core()
      for i = 1, 60 do
        WF:Guard("test", function() error("distinct " .. i) end)()
      end
      assert.are.equal(50, #WF.errors)
      assert.are.equal(10, WF.droppedErrors)
      assert.are.equal(60, #wow.errors())
    end)
  end)

  describe("notifications", function()
    it("calls listeners in order with the arguments, and stops after Off", function()
      load_core()
      local seen = {}
      local a = WF:On("ping", function(x, y) seen[#seen + 1] = "a" .. x .. y end)
      WF:On("ping", function(x) seen[#seen + 1] = "b" .. x end)
      WF:On("ping", a) -- a second On of the same function is ignored
      WF:Fire("ping", 1, 2)
      assert.are.same({ "a12", "b1" }, seen)
      WF:Off("ping", a)
      WF:Fire("ping", 3, 4)
      assert.are.same({ "a12", "b1", "b3" }, seen)
      WF:Fire("nobody", 1) -- no listeners: nothing happens
    end)

    it("records a throwing listener and still runs the others", function()
      load_core()
      local ran = false
      WF:On("ping", function() error("listener broke") end)
      WF:On("ping", function() ran = true end)
      WF:Fire("ping")
      assert.is_true(ran)
      assert.are.equal(1, #WF.errors)
      assert.are.equal("core", WF.errors[1].module)
    end)

    it("fires \"error\" for each recorded error, without looping on a failing listener", function()
      load_core()
      local records = {}
      WF:On("error", function(record) records[#records + 1] = record.count end)
      local f = WF:Guard("test", function() error("boom") end)
      f()
      f()
      assert.are.same({ 1, 2 }, records)
      WF:On("error", function() error("error listener broke") end)
      f()
      assert.are.equal(2, #WF.errors) -- boom, plus the listener's own error recorded once
    end)

    it("fires one synthetic record counting errors dropped at the cap", function()
      load_core()
      local seen = {}
      WF:On("error", function(record) if record.synthetic then seen[#seen + 1] = record end end)
      for i = 1, 53 do WF:Guard("test", function() error("distinct " .. i) end)() end
      assert.are.equal(3, #seen)
      assert.are.equal(seen[1], seen[3]) -- the same record, updated
      assert.are.equal(3, seen[3].count)
      assert.are.equal(50, #WF.errors) -- not added to the error list
    end)

    it("keeps WF.Log a no-op until the field log replaces it", function()
      load_core()
      assert.is_false(WF.Log("note", { tx = "x" }))
    end)
  end)

  describe("module options", function()
    local function with_option(default)
      return test_module({ slash = {}, options = {
        { key = "testOption", title = "Test option", desc = "An option.", default = default },
      } })
    end

    it("reads the default, saves a change and fires \"option\"", function()
      load_core()
      WF:RegisterModule("test", with_option(false))
      WF:Initialize()
      local fired = {}
      WF:On("option", function(key, value) fired[#fired + 1] = key .. "=" .. tostring(value) end)
      assert.is_false(WF:GetOption("testOption"))
      WF:SetOption("testOption", true)
      assert.is_true(WF:GetOption("testOption"))
      assert.is_true(WF.db.options.testOption)
      assert.are.same({ "testOption=true" }, fired)
      assert.is_false(WF:GetOption("unknown"))
      assert.has_error(function() WF:SetOption("unknown", true) end)
    end)

    it("shows options under their module's toggle, disabled while the module is off", function()
      load_core()
      WF:RegisterModule("test", with_option(true))
      WF:Initialize()
      WF:Start()
      local args = WF:BuildOptionsTable().args
      local option = args.test_opt_testOption
      assert.are.equal("toggle", option.type)
      assert.is_true(option.order > args.test_desc.order and option.order < 20)
      assert.is_true(option.disabled())
      assert.is_true(option.get())
      option.set(nil, false)
      assert.is_false(WF:GetOption("testOption"))
    end)

    it("rejects bad or duplicate option keys", function()
      load_core()
      WF:RegisterModule("a", with_option(false))
      assert.has_error(function() WF:RegisterModule("b", with_option(false)) end)
      assert.has_error(function()
        WF:RegisterModule("c", test_module({ slash = {}, options = { { key = "x y", title = "X", default = false } } }))
      end)
      assert.has_error(function()
        WF:RegisterModule("d", test_module({ slash = {}, options = { { key = "z", title = "Z" } } }))
      end)
      assert.has_error(function()
        WF:RegisterModule("e", test_module({ slash = {}, options = {
          { key = "twice", title = "A", default = false }, { key = "twice", title = "B", default = true } } }))
      end)
      assert.is_nil(WF.GetModule("e"))
    end)
  end)

  describe("RunChunked", function()
    local function steps(n, log)
      local list = {}
      for i = 1, n do list[i] = function() log[#log + 1] = i end end
      return list
    end

    it("runs every step in order across frames within the budget", function()
      load_core()
      wow.set_profile_step(3) -- every clock read costs 3 ms
      local log, done = {}
      local handle = WF:RunChunked(steps(10, log), function(status) done = status end, 8)
      assert.are.same({}, log) -- nothing runs before the next frame
      wow.next_frame()
      assert.is_true(#log >= 1 and #log < 10)
      for _ = 1, 20 do
        if not handle.IsRunning() then break end
        wow.next_frame()
      end
      assert.are.same({ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 }, log)
      assert.are.equal("done", done)
      assert.is_true(handle.frames > 1)
      assert.are.equal(10, handle.steps)
    end)

    it("accepts an iterator and keeps going after a step error", function()
      load_core()
      local i, log = 0, {}
      local function iterator()
        i = i + 1
        if i > 3 then return nil end
        local n = i
        return function()
          if n == 2 then error("step 2 failed") end
          log[#log + 1] = n
        end
      end
      local done
      WF:RunChunked(iterator, function(status) done = status end)
      for _ = 1, 10 do wow.next_frame() end
      assert.are.same({ 1, 3 }, log)
      assert.are.equal("done", done)
      assert.are.equal(1, #WF.errors)
    end)

    it("stops cleanly when its module is disabled mid-run", function()
      load_core()
      WF:RegisterModule("test", test_module({ default = true }))
      WF:Initialize()
      WF:Start()
      wow.set_profile_step(10) -- one step per frame
      local log, done = {}
      WF:RunChunked(steps(5, log), function(status) done = status end, 8, "test")
      wow.next_frame()
      assert.are.same({ 1 }, log)
      WF:SetEnabled("test", false)
      assert.are.equal("cancelled", done)
      for _ = 1, 10 do wow.next_frame() end
      assert.are.same({ 1 }, log)
      assert.are.equal(0, wow.pending_timers())
    end)

    it("finishes with \"error\" when the iterator throws", function()
      load_core()
      local n, done = 0
      WF:RunChunked(function()
        n = n + 1
        if n == 2 then error("iterator broke") end
        return function() end
      end, function(status) done = status end)
      for _ = 1, 5 do wow.next_frame() end
      assert.are.equal("error", done)
      assert.are.equal(1, #WF.errors)
    end)

    it("finishes with \"error\" on a hole in the steps array", function()
      load_core()
      local log, done = {}
      WF:RunChunked({ function() log[#log + 1] = 1 end, nil, function() log[#log + 1] = 3 end },
        function(status) done = status end)
      for _ = 1, 5 do wow.next_frame() end
      assert.are.equal("error", done)
      assert.are.same({ 1 }, log)
    end)

    it("can be cancelled through its handle", function()
      load_core()
      local log, done = {}
      local handle = WF:RunChunked(steps(3, log), function(status) done = status end)
      handle.Cancel()
      for _ = 1, 5 do wow.next_frame() end
      assert.are.same({}, log)
      assert.are.equal("cancelled", done)
      assert.is_false(handle.IsRunning())
    end)
  end)
end)
