-- Minimal WoW API stub for busted specs (Lua 5.1).
--
-- Stub only what specs need; grow it as modules arrive (P2). It must never
-- contain game data (quest, item, NPC, map IDs): those come from the client.
--
-- Usage in a spec:
--   local wow = require("wow-api")
--   before_each(function() wow.install() end)
--   after_each(function() wow.uninstall() end)
--   local f = CreateFrame("Frame")
--   f:RegisterEvent("PLAYER_LOGIN"); f:SetScript("OnEvent", handler)
--   wow.fire_event("PLAYER_LOGIN")
--
-- Every installed global is removed again by uninstall(), so specs do not
-- leak state into each other.

local M = {}

-- The Forever client reports WOW_PROJECT_ID 18 (CLAUDE.md, platform facts).
M.WOW_PROJECT_CAMELOT = 18

local state -- reset by M.reset()

-- ---------------------------------------------------------------------------
-- Frames and events

local Frame = {}
Frame.__index = Frame

function Frame:RegisterEvent(event)
  assert(type(event) == "string", "RegisterEvent: event name must be a string")
  self._events[event] = true
end

function Frame:UnregisterEvent(event)
  self._events[event] = nil
end

function Frame:UnregisterAllEvents()
  self._events = {}
end

function Frame:IsEventRegistered(event)
  return self._events[event] == true
end

function Frame:SetScript(name, fn)
  self._scripts[name] = fn
end

function Frame:GetScript(name)
  return self._scripts[name]
end

function Frame:Show() self._shown = true end
function Frame:Hide() self._shown = false end
function Frame:IsShown() return self._shown end
function Frame:GetName() return self._name end
function Frame:GetParent() return self._parent end
function Frame:GetObjectType() return self._type end

local function CreateFrame(frameType, name, parent)
  assert(type(frameType) == "string", "CreateFrame: frameType must be a string")
  local frame = setmetatable({
    _type = frameType,
    _name = name,
    _parent = parent,
    _events = {},
    _scripts = {},
    _shown = true,
  }, Frame)
  state.frames[#state.frames + 1] = frame
  if name then
    -- Named frames become globals in WoW.
    rawset(_G, name, frame)
    state.globals[name] = true
  end
  return frame
end

--- Deliver an event to every frame registered for it, in creation order,
--- as WoW does: OnEvent(self, event, ...).
function M.fire_event(event, ...)
  local delivered = 0
  for _, frame in ipairs(state.frames) do
    local handler = frame._scripts.OnEvent
    if frame._events[event] and handler then
      handler(frame, event, ...)
      delivered = delivered + 1
    end
  end
  return delivered
end

--- All frames created since the last reset (for "creates no frames" tests).
function M.frames()
  return state.frames
end

--- Number of frames registered for `event`, or for any event if nil.
function M.registered_count(event)
  local n = 0
  for _, frame in ipairs(state.frames) do
    if event == nil then
      if next(frame._events) ~= nil then n = n + 1 end
    elseif frame._events[event] then
      n = n + 1
    end
  end
  return n
end

-- ---------------------------------------------------------------------------
-- Time and timers (manual clock: nothing runs until a spec advances it)

local function GetTime()
  return state.now
end

local Timer = {}
Timer.__index = Timer
function Timer:Cancel() self._cancelled = true end
function Timer:IsCancelled() return self._cancelled end

local function schedule(seconds, callback)
  assert(type(seconds) == "number", "C_Timer: seconds must be a number")
  assert(type(callback) == "function", "C_Timer: callback must be a function")
  state.seq = state.seq + 1
  local timer = setmetatable({
    _due = state.now + seconds,
    _seq = state.seq,
    _callback = callback,
    _cancelled = false,
  }, Timer)
  state.timers[#state.timers + 1] = timer
  return timer
end

local C_Timer = {
  After = function(seconds, callback)
    schedule(seconds, callback)
  end,
  NewTimer = function(seconds, callback)
    local timer
    timer = schedule(seconds, function() callback(timer) end)
    return timer
  end,
}

--- Move the clock forward and run every timer that falls due, in due order.
function M.advance(seconds)
  local target = state.now + seconds
  while true do
    local nextIndex, nextTimer
    for i, timer in ipairs(state.timers) do
      if timer._due <= target and (nextTimer == nil
          or timer._due < nextTimer._due
          or (timer._due == nextTimer._due and timer._seq < nextTimer._seq)) then
        nextIndex, nextTimer = i, timer
      end
    end
    if not nextTimer then break end
    table.remove(state.timers, nextIndex)
    state.now = nextTimer._due
    if not nextTimer._cancelled then nextTimer._callback() end
  end
  state.now = target
end

function M.set_time(seconds)
  state.now = seconds
end

-- ---------------------------------------------------------------------------
-- Combat lockdown (a flag only; we never model combat itself)

local function InCombatLockdown()
  return state.inCombat
end

--- Enter or leave combat lockdown and fire the matching event, as the
--- client does (PLAYER_REGEN_DISABLED on entry, PLAYER_REGEN_ENABLED on exit).
function M.set_combat(inCombat)
  inCombat = inCombat and true or false
  if state.inCombat == inCombat then return end
  state.inCombat = inCombat
  M.fire_event(inCombat and "PLAYER_REGEN_DISABLED" or "PLAYER_REGEN_ENABLED")
end

-- ---------------------------------------------------------------------------
-- SavedVariables
--
-- The client sets each SavedVariables global before firing ADDON_LOADED for
-- the addon, and writes the globals back only at logout or /reload.

local function deep_copy(value, seen)
  if type(value) ~= "table" then return value end
  seen = seen or {}
  if seen[value] then return seen[value] end
  local copy = {}
  seen[value] = copy
  for k, v in pairs(value) do
    copy[deep_copy(k, seen)] = deep_copy(v, seen)
  end
  return copy
end

--- Simulate login: set the given SavedVariables globals (deep-copied, as if
--- read from disk; nil means "no file yet") and fire ADDON_LOADED.
function M.load_saved_variables(addonName, variables)
  for name, value in pairs(variables or {}) do
    rawset(_G, name, deep_copy(value))
    state.globals[name] = true
  end
  return M.fire_event("ADDON_LOADED", addonName)
end

--- Simulate logout: return a deep copy of the named globals as the client
--- would write them to the SavedVariables file.
function M.write_saved_variables(names)
  local out = {}
  for _, name in ipairs(names) do
    out[name] = deep_copy(rawget(_G, name))
  end
  return out
end

-- ---------------------------------------------------------------------------
-- Install / uninstall

local function api()
  return {
    CreateFrame = CreateFrame,
    GetTime = GetTime,
    C_Timer = C_Timer,
    InCombatLockdown = InCombatLockdown,
    WOW_PROJECT_ID = M.WOW_PROJECT_CAMELOT,
    WOW_PROJECT_CAMELOT = M.WOW_PROJECT_CAMELOT,
  }
end

function M.reset()
  state = {
    frames = {},
    timers = {},
    seq = 0,
    now = 0,
    inCombat = false,
    globals = state and state.globals or {},
  }
end

--- Put the stub API into _G. `overrides` replaces or adds globals for one
--- spec (e.g. { WOW_PROJECT_ID = 1 } to simulate another client).
function M.install(overrides)
  M.uninstall()
  for name, value in pairs(api()) do
    rawset(_G, name, value)
    state.globals[name] = true
  end
  for name, value in pairs(overrides or {}) do
    rawset(_G, name, value)
    state.globals[name] = true
  end
end

--- Remove every global the stub set (API, named frames, SavedVariables).
function M.uninstall()
  if state then
    for name in pairs(state.globals) do
      rawset(_G, name, nil)
    end
  end
  state = nil
  M.reset()
end

M.reset()

return M
