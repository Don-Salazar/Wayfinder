-- Modules/Core.lua
-- Purpose: the shared core for Wayfinder's own modules (addon.WF).
--   * Module registry: WF:RegisterModule(id, def). Core calls def.OnEnable
--     only while the module's toggle is on and def.OnDisable when it goes off,
--     so a module that is off creates no frames and registers no events
--     (CLAUDE.md "Everything is optional", DESIGN section 6).
--   * Persistence: account-wide WayfinderData (toggles, selftest, later dump)
--     and per-character WayfinderCharData (later the field log). Upstream's
--     saved variables are never touched.
--   * Options: one "Wayfinder modules" page under the addon's options
--     category, one toggle per module; toggling applies at once.
--   * Slash: /wf <subcommand> reaches our modules through one tagged line in
--     upstream's ChatCommand (SettingsPanel.lua). /wf modules lists them.
--   * WF:Guard / WF:Call: guarded calls that record errors for the field log
--     (docs/FIELD_LOG.md section 3 "Errors") and re-raise to geterrorhandler().
--   * WF:RunChunked: runs small steps across frames under a time budget.
-- Release vs development defaults come from the TOC Version (0.x or -dev).
-- Licence: CC BY-NC-SA 4.0, Wayfinder contributors
-- Date: 2026-11-17

local addonName, addon = ...

local WF = {}
addon.WF = WF

local CHAT_PREFIX = "|cff33ff99Wayfinder|r: "
local OPTIONS_APP = "Wayfinder modules"
local CORE_ID = "core"
local MAX_ERRORS = 50
local MAX_STACK_CHARS = 4000
local DEFAULT_BUDGET_MS = 8

local modules = {} -- id -> { id, def, enabled, failed }
local order = {} -- ids in registration order
local slashOwners = {} -- lower-case subcommand -> module id
local runs = {} -- active RunChunked handles -> true
local errorIndex = {} -- module .. "\0" .. message -> error record

-- Session error list for the field log: { message, stack, module, count, time }.
WF.errors = {}
WF.droppedErrors = 0

local function pack(...)
    return { n = select("#", ...), ... }
end

-- ---------------------------------------------------------------------------
-- Development vs release

--- True for a development version string: "0.x..." or anything with "-dev".
--- A missing version counts as a release (the safer defaults).
function WF.IsDevelopmentVersion(version)
    if type(version) ~= "string" then return false end
    return version:find("^0%.") ~= nil or version:lower():find("%-dev") ~= nil
end

local function readMetadata(field)
    local get = (C_AddOns and C_AddOns.GetAddOnMetadata) or GetAddOnMetadata
    if type(get) ~= "function" then return nil end
    local ok, value = pcall(get, addonName, field)
    if ok and type(value) == "string" then return value end
    return nil
end

WF.version = readMetadata("Version")
-- The one switch between devDefault and default for never-set toggles.
WF.isDevelopment = WF.IsDevelopmentVersion(WF.version)

-- ---------------------------------------------------------------------------
-- Chat output

function WF.Print(message)
    local text = CHAT_PREFIX .. tostring(message)
    local frame = DEFAULT_CHAT_FRAME
    if frame and frame.AddMessage then
        frame:AddMessage(text)
    else
        print(text)
    end
end

-- ---------------------------------------------------------------------------
-- Errors: record, then hand to the default error handler

local function captureError(err)
    local stack
    if type(debugstack) == "function" then
        local ok, text = pcall(debugstack, 2)
        if ok and type(text) == "string" then stack = text:sub(1, MAX_STACK_CHARS) end
    end
    return { message = tostring(err), stack = stack }
end

--- Record an error for the field log (deduplicated per module and message,
--- at most MAX_ERRORS distinct records), then pass it to geterrorhandler().
function WF:ReportError(moduleId, message, stack)
    moduleId = tostring(moduleId or CORE_ID)
    message = tostring(message)
    local key = moduleId .. "\0" .. message
    local record = errorIndex[key]
    if record then
        record.count = record.count + 1
    elseif #self.errors < MAX_ERRORS then
        record = {
            message = message,
            stack = stack,
            module = moduleId,
            count = 1,
            time = type(GetTime) == "function" and GetTime() or 0,
        }
        errorIndex[key] = record
        self.errors[#self.errors + 1] = record
    else
        self.droppedErrors = self.droppedErrors + 1
    end
    local handler = type(geterrorhandler) == "function" and geterrorhandler()
    if type(handler) == "function" then
        pcall(handler, message)
    end
    return record
end

--- The session's error records (read-only by convention).
function WF:GetErrors()
    return self.errors
end

--- Call fn(...) under xpcall. Returns true, results... on success; on error
--- records and re-raises (to the error handler) and returns false.
function WF:Call(moduleId, fn, ...)
    local args = pack(...)
    local results
    local ok, captured = xpcall(function()
        results = pack(fn(unpack(args, 1, args.n)))
    end, captureError)
    if ok then
        return true, unpack(results, 1, results.n)
    end
    self:ReportError(moduleId, captured.message, captured.stack)
    return false
end

--- Wrap fn for use as an event handler or entry point of moduleId.
function WF:Guard(moduleId, fn)
    assert(type(fn) == "function", "WF:Guard: fn must be a function")
    local core = self
    return function(...)
        return select(2, core:Call(moduleId, fn, ...))
    end
end

-- ---------------------------------------------------------------------------
-- Frame-budget scheduler

--- Run steps (an array of functions, or an iterator function returning the
--- next step or nil) across frames, spending at most budgetMs per frame (at
--- least one step per frame). Each step runs guarded. onDone(status, handle)
--- gets "done" or "cancelled". With moduleId, the run stops when that module
--- is disabled. Returns a handle with :Cancel() and :IsRunning().
function WF:RunChunked(steps, onDone, budgetMs, moduleId)
    assert(type(steps) == "table" or type(steps) == "function", "WF:RunChunked: steps must be a table or function")
    budgetMs = tonumber(budgetMs) or DEFAULT_BUDGET_MS
    local owner = moduleId or CORE_ID
    local nextStep
    if type(steps) == "function" then
        nextStep = steps
    else
        local i = 0
        nextStep = function()
            i = i + 1
            return steps[i]
        end
    end

    local clock = type(debugprofilestop) == "function" and debugprofilestop or nil
    local core = self
    local handle = { moduleId = moduleId, steps = 0, frames = 0, running = true }

    local function finish(status)
        if not handle.running then return end
        handle.running = false
        handle.status = status
        runs[handle] = nil
        if onDone then core:Call(owner, onDone, status, handle) end
    end

    function handle.Cancel()
        finish("cancelled")
    end

    function handle.IsRunning()
        return handle.running
    end

    local function runFrame()
        if not handle.running then return end
        if moduleId and not core:IsEnabled(moduleId) then
            finish("cancelled")
            return
        end
        handle.frames = handle.frames + 1
        local started = clock and clock() or 0
        repeat
            local gotStep, step = core:Call(owner, nextStep)
            if not gotStep or step == nil then
                finish("done")
                return
            end
            handle.steps = handle.steps + 1
            core:Call(owner, step)
            if not handle.running then return end
        until not clock or clock() - started >= budgetMs
        C_Timer.After(0, runFrame)
    end

    runs[handle] = true
    C_Timer.After(0, runFrame)
    return handle
end

function WF.CancelRuns(moduleId)
    for handle in pairs(runs) do
        if handle.moduleId == moduleId then handle.Cancel() end
    end
end

-- ---------------------------------------------------------------------------
-- Module registry

local RESERVED_SLASH = { modules = true }

--- def = { title, desc, default (boolean), devDefault (optional boolean),
---         OnEnable(def), OnDisable(def), slash = { name = handler(args) } }
function WF:RegisterModule(id, def)
    assert(type(id) == "string" and id:match("^%a[%w_]*$"), "WF:RegisterModule: id must be a plain word")
    assert(id ~= CORE_ID and not modules[id], "WF:RegisterModule: id '" .. id .. "' is taken")
    assert(type(def) == "table", "WF:RegisterModule: def must be a table")
    assert(type(def.title) == "string", "WF:RegisterModule: def.title must be a string")
    assert(type(def.default) == "boolean", "WF:RegisterModule: def.default must be a boolean")
    assert(def.devDefault == nil or type(def.devDefault) == "boolean", "WF:RegisterModule: bad devDefault")
    assert(type(def.OnEnable) == "function" and type(def.OnDisable) == "function",
        "WF:RegisterModule: OnEnable and OnDisable are required")
    local handlers = {}
    for name, handler in pairs(def.slash or {}) do
        assert(type(name) == "string" and type(handler) == "function", "WF:RegisterModule: bad slash entry")
        local key = name:lower()
        assert(not RESERVED_SLASH[key] and not slashOwners[key], "WF:RegisterModule: slash '" .. key .. "' is taken")
        handlers[key] = handler
    end
    for key in pairs(handlers) do slashOwners[key] = id end
    modules[id] = { id = id, def = def, enabled = false, slash = handlers }
    order[#order + 1] = id
    if self.started then self:ApplyState(id) end
    return modules[id]
end

function WF.GetModuleIds()
    local ids = {}
    for i, id in ipairs(order) do ids[i] = id end
    return ids
end

function WF.GetModule(id)
    local record = modules[id]
    return record and record.def or nil
end

function WF:GetDefault(id)
    local def = modules[id] and modules[id].def
    if not def then return false end
    if self.isDevelopment and def.devDefault ~= nil then return def.devDefault end
    return def.default
end

--- The toggle as the player set it, or the default if never set.
function WF:GetToggle(id)
    local toggles = self.db and self.db.toggles
    local saved = toggles and toggles[id]
    if saved ~= nil then return saved and true or false end
    return self:GetDefault(id)
end

--- Whether the module is running now.
function WF.IsEnabled(_, id)
    local record = modules[id]
    return record ~= nil and record.enabled
end

--- Enable or disable a module at run time when its toggle says so.
function WF:ApplyState(id)
    local record = modules[id]
    if not record or not self.started then return end
    local want = self:GetToggle(id)
    if want and not record.enabled then
        record.enabled = true
        record.failed = nil
        local ok = self:Call(id, record.def.OnEnable, record.def)
        if not ok then
            local last = self.errors[#self.errors]
            record.failed = last and last.message or "OnEnable failed"
            record.enabled = false
            WF.CancelRuns(id)
            self:Call(id, record.def.OnDisable, record.def)
        end
    elseif not want and record.enabled then
        record.enabled = false
        WF.CancelRuns(id)
        self:Call(id, record.def.OnDisable, record.def)
    end
end

local function notifyOptions(self)
    if not self.optionsRegistered or not LibStub then return end
    local registry = LibStub("AceConfigRegistry-3.0", true)
    if registry then pcall(registry.NotifyChange, registry, OPTIONS_APP) end
end

--- Set a module's toggle (saved) and apply it at once.
function WF:SetEnabled(id, on)
    assert(modules[id], "WF:SetEnabled: unknown module '" .. tostring(id) .. "'")
    assert(self.db, "WF:SetEnabled: called before WF:Initialize")
    self.db.toggles[id] = on and true or false
    self:ApplyState(id)
    notifyOptions(self)
end

-- ---------------------------------------------------------------------------
-- Options page

function WF:BuildOptionsTable()
    local core = self
    local args = {
        intro = {
            type = "description",
            order = 0,
            fontSize = "medium",
            name = "Turn Wayfinder's own modules on or off. Changes apply at once. "
                .. "A module that is off creates no frames and registers no events.",
        },
    }
    for i, id in ipairs(order) do
        local def = modules[id].def
        args[id] = {
            type = "toggle",
            order = i * 10,
            width = "full",
            name = def.title,
            desc = def.desc,
            get = function() return core:GetToggle(id) end,
            set = function(_, value) core:SetEnabled(id, value) end,
        }
        args[id .. "_desc"] = {
            type = "description",
            order = i * 10 + 1,
            name = def.desc or "",
        }
    end
    return { type = "group", name = OPTIONS_APP, args = args }
end

function WF:RegisterOptions()
    if self.optionsRegistered or not LibStub then return end
    local config = LibStub("AceConfig-3.0", true)
    local dialog = LibStub("AceConfigDialog-3.0", true)
    if not (config and dialog) then return end
    local core = self
    config:RegisterOptionsTable(OPTIONS_APP, function() return core:BuildOptionsTable() end)
    -- AddToBlizOptions raises if the parent category is unknown, so only name
    -- the parent once upstream's main panel is registered under addon.title.
    local parent = addon.title
    local known = dialog.BlizOptionsIDMap
    if not (parent and type(known) == "table" and known[parent]) then parent = nil end
    dialog:AddToBlizOptions(OPTIONS_APP, OPTIONS_APP, parent)
    self.optionsRegistered = true
end

-- ---------------------------------------------------------------------------
-- Slash commands

local function listModules(self)
    WF.Print("modules (" .. (self.isDevelopment and "development" or "release") .. " build "
        .. tostring(self.version) .. "):")
    if #order == 0 then
        WF.Print("  none registered")
        return
    end
    for _, id in ipairs(order) do
        local record = modules[id]
        local state = record.enabled and "on" or "off"
        if record.failed then state = state .. " (failed to start: " .. record.failed .. ")" end
        WF.Print(("  %s - %s: %s (default %s)"):format(id, record.def.title, state,
            self:GetDefault(id) and "on" or "off"))
    end
    WF.Print("  /wf modules <id> on|off")
end

local function slashModules(self, rest)
    local id, value = rest:match("^(%S+)%s+(%S+)$")
    if not id then
        listModules(self)
        return
    end
    value = value:lower()
    if not modules[id] then
        WF.Print("no module '" .. id .. "'. /wf modules lists them.")
    elseif value ~= "on" and value ~= "off" then
        WF.Print("use /wf modules " .. id .. " on|off")
    elseif not self.db then
        WF.Print("not ready yet; try again after login.")
    else
        self:SetEnabled(id, value == "on")
        WF.Print(modules[id].def.title .. " is " .. (self:IsEnabled(id) and "on" or "off") .. ".")
    end
end

local function handleSlash(self, input)
    if type(input) ~= "string" then return false end
    local command, rest = input:match("^%s*(%S+)%s*(.-)%s*$")
    if not command then return false end
    command = command:lower()
    if command == "modules" then
        slashModules(self, rest)
        return true
    end
    local id = slashOwners[command]
    if not id then return false end
    local record = modules[id]
    if not record.enabled then
        WF.Print(record.def.title .. " is off. Turn it on with /wf modules " .. id .. " on, or in Options.")
        return true
    end
    self:Call(id, record.slash[command], rest)
    return true
end

--- Called from upstream's ChatCommand before its own handling. Returns true
--- when the subcommand belongs to Wayfinder's core or one of its modules.
function WF:HandleSlash(input)
    local ok, handled = self:Call(CORE_ID, handleSlash, self, input)
    return ok and handled == true
end

-- ---------------------------------------------------------------------------
-- Lifecycle

--- After SavedVariables are loaded (ADDON_LOADED): bind the saved tables and
--- register the options page.
function WF:Initialize()
    if self.initialized then return end
    self.initialized = true
    local data = WayfinderData
    if type(data) ~= "table" then
        data = {}
        WayfinderData = data
    end
    if type(data.toggles) ~= "table" then data.toggles = {} end
    local charData = WayfinderCharData
    if type(charData) ~= "table" then
        charData = {}
        WayfinderCharData = charData
    end
    self.db = data
    self.charDb = charData
    self:Call(CORE_ID, self.RegisterOptions, self)
end

--- At login: enable every module whose toggle is on.
function WF:Start()
    if self.started then return end
    if not self.initialized then self:Initialize() end
    self.started = true
    for _, id in ipairs(order) do self:ApplyState(id) end
end

-- In the client, hook into the AceAddon lifecycle: a module's OnInitialize
-- runs after the main addon's (FIFO), so upstream's options panel exists;
-- OnEnable runs at PLAYER_LOGIN.
if type(addon.NewModule) == "function" then
    local aceModule = addon:NewModule("WayfinderCore")
    function aceModule.OnInitialize()
        WF:Call(CORE_ID, WF.Initialize, WF)
    end
    function aceModule.OnEnable()
        WF:Call(CORE_ID, WF.Start, WF)
    end
end
