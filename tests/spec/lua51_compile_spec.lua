-- Every shipped .lua file must compile under real Lua 5.1, as the client
-- uses. See tests/support/lua51_compile.lua for the file list and baseline.

local compile = require("support.lua51_compile")

describe("Lua 5.1 interpreter", function()
  it("is PUC-Rio Lua 5.1, not LuaJIT or a newer Lua", function()
    assert.are.equal("Lua 5.1", _VERSION)
    assert.is_nil(rawget(_G, "jit"))
  end)

  it("rejects syntax newer than 5.1", function()
    -- If these compile, the suite is not running on 5.1 and the compile
    -- check below proves nothing.
    assert.is_nil((loadstring("goto done ::done::")))
    assert.is_nil((loadstring("return 7 // 2")))
    assert.is_nil((loadstring("return 1 & 2")))
  end)
end)

describe("shipped Lua files", function()
  local root = compile.repo_root()

  it("are found from the repo root", function()
    local files = compile.shipped_files(root)
    -- The unmodified fork ships about a thousand files; a tiny number means
    -- the enumeration broke, which would make the next test pass vacuously.
    assert.is_true(#files > 100, "only " .. #files .. " files found under " .. root)
    for _, rel in ipairs(files) do
      assert.is_nil(rel:find("\\", 1, true), "path not normalised: " .. rel)
    end
  end)

  it("all compile under Lua 5.1 (apart from the documented baseline)", function()
    local checked, unexpected, stale = compile.check(root)
    assert.is_true(checked > 0)
    assert.are.same({}, unexpected,
      "files that do not compile under Lua 5.1:\n  " .. table.concat(unexpected, "\n  "))
    assert.are.same({}, stale,
      "baseline entries that no longer fail (remove them):\n  " .. table.concat(stale, "\n  "))
  end)

  it("reports source that does not compile, and accepts a UTF-8 BOM", function()
    -- Guard the guard: a parser error must come back as a message naming
    -- the file, never as nil.
    local err = compile.compile_source("local x = (\n", "broken.lua")
    assert.is_string(err)
    assert.truthy(err:find("broken.lua", 1, true))
    assert.is_nil(compile.compile_source("\239\187\191return 1\n", "bom.lua"))
  end)
end)
