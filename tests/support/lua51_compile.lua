-- Support for tests/spec/lua51_compile_spec.lua.
--
-- Compiles (never executes) every .lua file the addon ships, under the Lua
-- interpreter running busted, which must be PUC-Rio Lua 5.1 like the client.
-- luacheck's parser accepts 5.2+ syntax (goto, //, bit operators, \z, ...),
-- so this is the real guard against code the client cannot load.

local lfs = require("lfs")

local M = {}

-- Directories whose .lua files are packaged into the addon, plus the .lua
-- files directly in the repo root. Scripts/ is not shipped (.pkgmeta ignore).
-- Add our own directories here as they appear (Modules, Data).
M.SHIPPED_DIRS = { "DB", "Guides", "lang", "libs", "locale", "UI", "Modules", "Data" }

-- Known upstream files that do not compile under Lua 5.1, keyed by path
-- relative to the repo root (forward slashes), value = a substring of the
-- expected error. Upstream files are not edited; a file listed here is
-- tolerated, any other failure breaks the suite, and an entry that no longer
-- fails must be removed. Empty on the unmodified fork (checked 2026-11-16).
M.BASELINE = {
}

-- Repo root, derived from this file's location (tests/support/), so the
-- suite works from any working directory and on any OS.
function M.repo_root()
  local source = debug.getinfo(1, "S").source
  local path = source:sub(1, 1) == "@" and source:sub(2) or "."
  path = path:gsub("\\", "/")
  local root = path:match("^(.*)/tests/support/[^/]+$")
  if root == nil then
    root = path:match("^tests/support/") and "." or nil
  end
  assert(root, "cannot locate repo root from " .. path)
  if root == "" then root = "/" end
  return root
end

local function is_dir(path)
  return lfs.attributes(path, "mode") == "directory"
end

local function ends_with_lua(name)
  return name:sub(-4):lower() == ".lua"
end

-- Recursive walk; `rel` is the path relative to the root, with "/".
local function walk(root, rel, out)
  local full = root .. "/" .. rel
  for name in lfs.dir(full) do
    if name ~= "." and name ~= ".." then
      local childRel = rel .. "/" .. name
      local mode = lfs.attributes(root .. "/" .. childRel, "mode")
      if mode == "directory" then
        walk(root, childRel, out)
      elseif mode == "file" and ends_with_lua(name) then
        out[#out + 1] = childRel
      end
    end
  end
end

--- Sorted list of shipped .lua files, relative to root, "/"-separated.
function M.shipped_files(root)
  local out = {}
  for name in lfs.dir(root) do
    if ends_with_lua(name) and lfs.attributes(root .. "/" .. name, "mode") == "file" then
      out[#out + 1] = name
    end
  end
  for _, dir in ipairs(M.SHIPPED_DIRS) do
    if is_dir(root .. "/" .. dir) then
      walk(root, dir, out)
    end
  end
  table.sort(out)
  return out
end

--- Compile one file without running it. Returns nil on success, or the
--- error message.
function M.compile(root, rel)
  local handle, openErr = io.open(root .. "/" .. rel, "rb")
  if not handle then return "cannot open: " .. tostring(openErr) end
  local source = handle:read("*a")
  handle:close()
  return M.compile_source(source, rel)
end

--- Compile a source string; same contract as compile().
function M.compile_source(source, chunkname)
  -- The client accepts a UTF-8 byte-order mark; stock Lua 5.1 does not.
  if source:sub(1, 3) == "\239\187\191" then source = source:sub(4) end
  local fn, err = loadstring(source, "@" .. chunkname)
  if fn then return nil end
  return err
end

--- Compile every shipped file. Returns:
---   checked   number of files compiled
---   unexpected  list of "path: error" not covered by the baseline
---   stale       list of baseline paths that now compile or are gone
function M.check(root)
  root = root or M.repo_root()
  local files = M.shipped_files(root)
  local unexpected, failedBaseline = {}, {}
  for _, rel in ipairs(files) do
    local err = M.compile(root, rel)
    if err then
      local expected = M.BASELINE[rel]
      if expected and err:find(expected, 1, true) then
        failedBaseline[rel] = true
      else
        unexpected[#unexpected + 1] = rel .. ": " .. err
      end
    end
  end
  local stale = {}
  for rel in pairs(M.BASELINE) do
    if not failedBaseline[rel] then stale[#stale + 1] = rel end
  end
  table.sort(stale)
  return #files, unexpected, stale
end

return M
