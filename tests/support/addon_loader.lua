-- Load addon files in a spec the way the client does: each file is a chunk
-- called with the varargs (addonName, addon), in TOC order, all sharing one
-- private addon table.
--
--   local loader = require("support.addon_loader")
--   local addon = loader.load({ "Modules/Core.lua", "Modules/SelfTest.lua" })
--
-- Paths are relative to the repo root (busted runs from there).

local M = {}

M.ADDON_NAME = "Wayfinder"

-- The globals our modules may create (their SavedVariables).
M.SAVED_VARIABLES = { "WayfinderData", "WayfinderCharData" }

--- Load `files` into `addon` (a new table if nil) and return it. With `wow`
--- (the stub), the SavedVariables globals are tracked so uninstall() removes
--- them.
function M.load(files, addon, wow)
  addon = addon or {}
  for _, path in ipairs(files) do
    local chunk, err = loadfile(path)
    assert(chunk, err)
    chunk(M.ADDON_NAME, addon)
  end
  if wow then
    for _, name in ipairs(M.SAVED_VARIABLES) do wow.track(name) end
  end
  return addon
end

--- Sorted list of the keys of the global table (for "no global leaks" tests).
function M.global_keys()
  local keys = {}
  for key in pairs(_G) do keys[#keys + 1] = tostring(key) end
  table.sort(keys)
  return keys
end

--- Globals in `after` that are not in `before` (both from global_keys()).
function M.new_globals(before, after)
  local seen, added = {}, {}
  for _, key in ipairs(before) do seen[key] = true end
  for _, key in ipairs(after) do
    if not seen[key] then added[#added + 1] = key end
  end
  return added
end

return M
