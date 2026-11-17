local addonName, addon = ...
addon.guides = {}
addon.guideList = {}
addon.guideIds = {}

local class = addon.player.class
local race = addon.player.race

local locale = GetLocale()
local fmt, tremove, tinsert = string.format, tremove, table.insert
local unpack = unpack
local strchar = string.char
local strbyte = string.byte
local bitand = bit.band
local bitxor = bit.bxor
-- WF: removed the LibDeflate handle; only the removed guide import and cache code used it
local RXPGuides = addon.RXPGuides
addon.condenseGroups = {}

local game = strlower(addon.game)
--local suffix = 1
-- Alias addon.locale.Get
local L = addon.locale.Get

-- File guides and string-imports need different load order support
local embeddedGuides = {}
addon.embeddedGuides = embeddedGuides

addon.minGuideVersion = 0
addon.maxGuideVersion = 0

addon.classicPrefix = "C-"

local aCache = {}

local function applies(textEntry,customClass,func)
    if textEntry then
        --if not(textEntry:match("Alliance") or textEntry:match("Horde")) then return true end
        local function parse(text,customClass)
            local isMatch = false
            text = text:gsub("(!?)%(%s*(.-)%s*%)",function(op,m)
                if parse(m,customClass) ~= (op == "!") then
                    return class
                else
                    return "NULL"
                end
            end)
            local faction = addon.player.faction
            local playerLevel = UnitLevel("player") or 1
            for str in string.gmatch(text, "[^/]+") do
                local v = true
                for entry in string.gmatch(str, "!?[%w%d]+") do
                    local state = false
                    local gendercheck
                    if entry:sub(1, 1) == "!" then
                        entry = entry:sub(2, -1)
                        state = true
                    end
                    local level = tonumber(entry) or 0xfff
                    local uppercase = strupper(entry)
                    if entry == "Undead" then
                        entry = "Scourge"
                    elseif uppercase == "DK" then
                        uppercase = "DEATHKNIGHT"
                    elseif uppercase == "MALE" and UnitSex("player") == 2 or
                        uppercase == "FEMALE" and UnitSex("player") == 3 then
                        gendercheck = true
                    elseif uppercase == "SOD" and addon.player.season == 2 then
                        entry = faction
                    elseif uppercase == "DF" then
                        entry = "RETAIL"
                    elseif faction == "Neutral" and not customClass and (entry == "Alliance" or entry == "Horde") then
                        entry = faction
                    elseif entry == "Haranir" then
                        entry = "Harronir"
                    end
                    local customCheck = func and func(entry, uppercase)
                    v = (not(gendercheck or uppercase == class or entry == race or
                             entry == faction or playerLevel >= level or uppercase == addon.game or entry == customClass or entry == locale or customCheck) ==
                             state)
                    if not v then
                        break
                    end
                end
                if v then
                    isMatch = true
                    break
                end
            end
            --print(isMatch and "TRUE" or "FALSE",'-',text)
            return isMatch
        end
        local match
        if not aCache[textEntry] then
            match = parse(textEntry,customClass)
            aCache[textEntry] = match
            return match
        else
            return aCache[textEntry]
        end
    end
    return true
end

addon.applies = applies
addon.farmGuides = 0

addon.affix = function(smin, smax)
    if smax:len() == 1 then smax = "0" .. smax end
    return "0" .. smin .. "-" .. smax
end

function addon.RegisterGroup(guideGroup, parentGroup)
    if not RXPGuides[guideGroup] then RXPGuides[guideGroup] = {} end
    local group = RXPGuides[guideGroup]
    if parentGroup then
        if not RXPGuides[parentGroup] then RXPGuides[parentGroup] = {} end
        local parent = RXPGuides[parentGroup]
        parent.__index = parent
        setmetatable(parent, addon.functions)
        setmetatable(group, parent)
    else
        setmetatable(group, addon.functions)
    end
end

-- Load guide into addon options
function addon.AddGuide(guide)
    -- Not applicable (e.g. wrong faction), rely on upstream functions to report parsing errors
    if not guide then return false end
    addon.GroupOverride(guide)
    local loadedGuide
    for _, checkGuide in ipairs(addon.guides) do
        if guide.key == checkGuide.key then
            loadedGuide = checkGuide
            break
        end
    end

    if loadedGuide and addon.settings.profile.debug then
        local debugText
        if guide.version == loadedGuide.version then
            debugText = fmt('Overwriting (%s) v%d', guide.key, guide.version)
        elseif guide.version > loadedGuide.version then
            debugText = fmt(
                            'Newer guide for (%s) already exists (%s) >= checkGuide (%d)',
                            guide.key, guide.version, loadedGuide.version)
        else
            debugText = fmt('Loading new version for (%s) v%d', guide.key,
                            guide.version)
        end

        -- WF: removed the debug line to the guide importer window (importer removed)
    end
    local group = guide.group
    if guide.lowPrio then
        group = guide.lowPrio
    end
    local index = fmt("%s||%s",guide.group,guide.name)
    addon.RegisterGroup(group,guide.group ~= group and guide.group)

    local groupDisplayName = group
    if guide.groupdisplayname then
        if guide.lowPrio and guide.lowPrio:sub(1,1) == "*" then
            groupDisplayName = "*" .. guide.groupdisplayname
        else
            groupDisplayName = guide.groupdisplayname
        end
    end
    if groupDisplayName ~= group then
        addon.condenseGroups[group] = groupDisplayName
    end
    if not addon.guideList[groupDisplayName] then
        addon.guideList[groupDisplayName] = {}
        addon.guideList[groupDisplayName].names_ = {}
    end
    --print(group,guide.group ~= group and guide.group)
    addon.guideList[groupDisplayName].weight_ = tonumber(guide.groupweight)
                                    or addon.guideList[groupDisplayName].weight_

    local list = addon.guideList[groupDisplayName]

    if guide.guideId then
        addon.guideIds[guide.guideId] = index
    end

    if loadedGuide then -- guide exists, but new version
        for i, checkGuide in ipairs(addon.guides) do
            if guide.key == checkGuide.key then
                addon.guides[i] = checkGuide
                break
            end
        end
    else -- guide doesn't exist, so insert
        if not addon.guides[index] then
            tinsert(list.names_, {name = guide.name, group = guide.group:gsub("^%*","")})
        end
        addon.guides[index] = guide

        list[guide.name] = index
        --TODO: remove this part
        if not guide.lowPrio and guide.defaultFor and
            not addon.defaultGuide then addon.defaultGuide = guide end
    end
    return true
end

function addon.GetActiveGuidesInGroup(groupName)
    local group = addon.guideList[groupName]
    if not group or not group.names_ then return {} end

    local guides = {}
    local guide
    for _, identity in ipairs(group.names_) do
        guide = addon.GetGuideTable(identity.group, identity.name)
        if guide and addon.IsGuideActive(guide) and not guide.chapter then
            guides[#guides + 1] = guide
        end
    end
    return guides
end

function addon.GetActiveGuidesByGroupId(groupId)
    local guides = {}
    for _, guide in pairs(addon.guides) do
        if guide.groupid == groupId and addon.IsGuideActive(guide) and not guide.chapter then
            guides[#guides + 1] = guide
        end
    end
    return guides
end

function addon.GetActiveGuidesByGroupNameOrId(groupName, groupId)
    local guides, seen = {}, {}
    if not groupName then return guides end

    local function addGuide(guide)
        if guide and not seen[guide] then
            seen[guide] = true
            guides[#guides + 1] = guide
        end
    end

    local translatedName = L(groupName)
    local unmarkedName
    for displayName in pairs(addon.guideList) do
        unmarkedName = displayName:gsub("^%*", "")
        if unmarkedName == groupName or unmarkedName == translatedName then
            for _, guide in ipairs(addon.GetActiveGuidesInGroup(displayName)) do
                addGuide(guide)
            end
        end
    end

    if groupId then
        for _, guide in ipairs(addon.GetActiveGuidesByGroupId(groupId)) do
            addGuide(guide)
        end
    end

    return guides
end

function addon.GetGuideSubgroups(guides)
    local categories, byName = {}, {}
    local category
    for _, guide in ipairs(guides) do
        if guide.subgroup then
            category = byName[guide.subgroup]
            if not category then
                category = {subgroup = guide.subgroup, subweight = tonumber(guide.subweight) or 0}
                byName[guide.subgroup] = category
                categories[#categories + 1] = category
            else
                category.subweight = tonumber(guide.subweight) or category.subweight
            end
        end
    end

    table.sort(categories, function(first, second)
        if first.subweight == second.subweight then
            return first.subgroup:gsub("^(%d)-(%d%d?)", addon.affix) <
                second.subgroup:gsub("^(%d)-(%d%d?)", addon.affix)
        end
        return first.subweight > second.subweight
    end)

    return categories
end

function addon.IsGuideSelectable(guide, subgroup, includeUnusedGuides)
    local profile = addon.settings.profile
    return not guide.disabled and
        not ((addon.player.hardcore or profile.hardcore) and guide.softcore) and
        (includeUnusedGuides or profile.showUnusedGuides or not guide.lowPrio) and
        (not subgroup or guide.subgroup == subgroup or guide.subgroup == L(subgroup))
end

function addon.GetSelectableGuidesInGroup(groupName, subgroup, includeUnusedGuides)
    local guides = {}
    for _, guide in ipairs(addon.GetActiveGuidesByGroupNameOrId(groupName, groupName)) do
        if addon.IsGuideSelectable(guide, subgroup, includeUnusedGuides) then
            guides[#guides + 1] = guide
        end
    end

    return guides
end

function addon.GroupHasGuides(groupName, subgroup, includeUnusedGuides)
    return #addon.GetSelectableGuidesInGroup(groupName, subgroup, includeUnusedGuides) > 0
end

function addon.RemoveGuide(guideKey)
    if not guideKey then return false end

    local loadedGuide
    for _, checkGuide in ipairs(addon.guides) do
        if guideKey == checkGuide.key then
            loadedGuide = checkGuide
            break
        end
    end

    if not loadedGuide then
        addon.comms.PrettyDebug('Guide not found (%s)', guideKey)

        return
    end

    if addon.currentGuide and addon.currentGuide.key == guideKey then
        addon:LoadGuide(addon.emptyGuide)
    end

    local list = addon.guideList[loadedGuide.group]

    for i, name in ipairs(list.names_) do
        if loadedGuide.name == name then
            tremove(list.names_, i)
            break
        end
    end

    for name, _ in pairs(list) do
        if type(name) ~= "table" then
            if loadedGuide.name == name then
                list[name] = nil
                list.sorted_ = false
                break
            end
        end
    end

    -- Doesn't actually remove from addon.guides
    for i, checkGuide in pairs(addon.guides) do
        if loadedGuide.key == checkGuide.key then
            -- soft delete, hard delete messes up sorting
            addon.guides[i] = addon.emptyGuide
            break
        end
    end

    if next(list.names_) == nil then addon.guideList[loadedGuide.group] = nil end

    addon:ScheduleTask(addon.RXPFrame.GenerateMenuTable)

    return true
end

-- WF: removed DeserializeTable, CheckDataIntegrity, CompressDeflate, CacheGuide, ImportGuide (encrypted guide import)

function addon.RegisterGuide(groupOrContent, text, defaultFor)
    if not groupOrContent then
        return error(L'Error: Guide has no contents')
    elseif addon.addonLoaded or
      (addon.addonLoaded == false and addon.settings.profile and
       (addon.settings.profile.preLoadData or not addon.player.hardcore)) then
        local importedGuide, errorMsg = addon.ParseGuide(groupOrContent, text,
                                                        defaultFor)

        return not errorMsg and addon.AddGuide(importedGuide)
    else
        tinsert(embeddedGuides, {
            groupOrContent = groupOrContent,
            text = text,
            defaultFor = defaultFor
        })
    end
end

-- WF: removed BuildCacheObject (only the removed guide cache used it)

function addon.A32(tbl)
    local readfunc, offset
    if type(tbl) == "table" then
        readfunc = unpack
        offset = -1
    elseif type(tbl) == "string" then
        readfunc = strbyte
        offset = 0
    else
        return
    end

    local length = #tbl

    local i = 1
    local a = 1
    local b = 0
    while i <= length - 15 do
        local x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15,
              x16 = readfunc(tbl, i + offset, i + 15 + offset)
        b = (b + 16 * a + 16 * x1 + 15 * x2 + 14 * x3 + 13 * x4 + 12 * x5 + 11 *
                x6 + 10 * x7 + 9 * x8 + 8 * x9 + 7 * x10 + 6 * x11 + 5 * x12 + 4 *
                x13 + 3 * x14 + 2 * x15 + x16) % 65521
        a = (a + x1 + x2 + x3 + x4 + x5 + x6 + x7 + x8 + x9 + x10 + x11 + x12 +
                x13 + x14 + x15 + x16) % 65521
        i = i + 16
    end
    while (i <= length) do
        local x = readfunc(tbl, i + offset, i + offset)
        a = (a + x) % 65521
        b = (b + a) % 65521
        i = i + 1
    end
    return bitand((b * 65536 + a), 0xffffffff)

end

-- WF: removed ReadCacheData (Battle.net-derived import key via addon.base/BNGetInfo; no import in Wayfinder)

local function LoadGuide(guideData,n)
    if guideData.cache then
        -- WF: removed replay of queued ImportGuide entries; ImportGuide is gone, so none are queued
    else
        local guide, errorMsg, metadata, length, key, group, name
        local enabled = true
        if RXPCData.guideDisabled[n] then
            enabled = false
        elseif not guideData.text then
            length = guideData.groupOrContent:len()
            local index = guideData.groupOrContent:find("[\r\n]%s*step")
            local header = index and guideData.groupOrContent:sub(1,index)
            if header then
                local subgroup, enabledFor
                enabled = false
                for line in header:gmatch("[^\r\n]+") do
                    if subgroup and name and group and enabledFor and enabled then
                        break
                    end
                    line = line:gsub("%-%-.*$","")
                    line = line:gsub("^%s*(#.+)%s*<<%s*(.+)", function(l,t)
                        if not applies(t) then
                            return ""
                        else
                            return l
                        end
                    end)
                    if not enabled then
                        local u = strupper(line)
                        if u:find("#" .. addon.game) or
                            (addon.game == "RETAIL" and u:find("#DF")) or (addon.game == "CLASSIC" and u:find("#FOREVER")) then
                            enabled = true
                        end
                    end
                    enabledFor = enabledFor or line:match("^%s*<<%s*(.-)%s*$")
                    group = group or line:match("^%s*#group%s+(.-)%s*$")
                    subgroup = subgroup or line:match("^%s*#subgroup%s+(.-)%s*$")
                    name = name or line:match("^%s*#name%s+(.-)%s*$")
                end
                enabled = enabled and (not enabledFor or applies(enabledFor))

                if enabled then
                    key = addon.BuildGuideKey(group,"",name)
                    guide = key and RXPCData.guideMetaData[key]
                else
                    RXPCData.guideDisabled[n] = length
                end
            end
            --print('g-ok',guide and guide.length)
        end

        if guide and guide.length == length then
            --print('w',guide.key)
            if (guide.defaultFor and not applies(guide.defaultFor)) or addon.game == "CLASSIC" and guide.forever and not guide.classic then
                guide.lowPrio = "*" .. group
                --print(group)
            else
                guide.lowPrio = nil
            end
            errorMsg = not (not guide.enabledFor or applies(guide.enabledFor))
            --print(guide,errorMsg,guide.enabledFor)
            addon.guideCache[guide.key] = function(self)
                local tbl = addon.ParseGuide(guideData.groupOrContent,guideData.text)
                if RXPCData and RXPCData.guideMetaData then
                    RXPCData.guideMetaData[guide.key] = metadata
                end
                if addon.player.faction == "Neutral" and tbl then
                    tbl.parse = self
                end
                return tbl
            end
        elseif enabled then
            guide, errorMsg, metadata =
                addon.ParseGuide(guideData.groupOrContent,
                                guideData.text,
                                guideData.defaultFor, true, group, key)
                --print('n2',guide and guide.key)
            enabled = not errorMsg
            if key and metadata then
                local cleanup = {}
                for guideKey,data in pairs(RXPCData.guideMetaData) do
                    if data.key == guide.key then
                        tinsert(cleanup,guideKey)
                    end
                end
                for _,guideKey in pairs(cleanup) do
                    RXPCData.guideMetaData[guideKey] = nil
                end
                RXPCData.guideMetaData[key] = metadata
            end
        end
        if enabled then
            if name and group and addon.guides[group .. "||" .. name] then
                addon.error("Error trying to load a guide already parsed: " .. group .. "/" .. name)
            end
            addon.AddGuide(guide)
        end
    end
end


--local embeddedGuidesLoaded
local loadedGuides = 0
function addon.GetLoadedGuides()
    return loadedGuides
end
function addon.LoadEmbeddedGuides(maxIterations)
    if not addon.db then
        error('Initialization error, db not set')
        return
    end
    -- if embeddedGuidesLoaded then
    --     return
    -- else
    --     embeddedGuidesLoaded = true
    -- end
    --A1 = GetTimePreciseSec()
    local nGuides = #embeddedGuides
    if not RXPCData.guideDisabled[0] or RXPCData.guideDisabled[0] <= nGuides then
        RXPCData.guideDisabled = {[0] = nGuides}
    end
    local iterations = 0
    for n = 1+loadedGuides,nGuides do
        iterations = iterations + 1
        if maxIterations and iterations > maxIterations then
            --print(iterations, maxIterations)
            break
        end
        local guideData = embeddedGuides[n]
        loadedGuides = n
        LoadGuide(guideData,n)
    end

    if addon.addonLoaded and loadedGuides == nGuides then
        table.wipe(embeddedGuides)
        loadedGuides = 0
    end

    --[[if addon.addonLoaded then
        embeddedGuides = nil
    else
        embeddedGuides = {}
    end]]

    --A1 = GetTimePreciseSec() - A1
    addon:ScheduleTask(addon.RXPFrame.GenerateMenuTable)
end

function addon.BuildGuideKey(arg1,arg2,arg3)
    if type(arg1) == "table" then
        return fmt("%s|%s|%s", arg1.group, arg1.subgroup or '',
                         arg1.name)
    elseif arg1 and arg3 then
        return fmt("%s|%s|%s", arg1, arg2 or '',
                         arg3)
    end
end

-- WF: removed LoadCachedGuides (login import from RXPString, cached imported guides in RXPDB); old data is ignored

function addon.LoadAllGuides()
    addon.LoadEmbeddedGuides()
    print'ok1'

    local n = 1
    if addon.player.hardcore then
        n = 2
    end

    for i = 1,n do
        for _,guide in pairs(addon.guides) do
            if not guide.steps then
                addon:FetchGuide(guide)
            end
        end
    end
    print('L-total time: ', debugprofilestop() - addon.startTime)
end

function addon.SelectDefaultGuide()
    if addon.player.level > 1 then return end
    if addon.currentGuide and not addon.currentGuide.empty then return end

    if addon.settings.profile.hardcore then
        addon:LoadGuideTable(addon.defaultGroupHC, addon.defaultGuideHC)
    else
        addon:LoadGuideTable(addon.defaultGroup, addon.defaultGuide)
    end
end

local function parseLine(linetext,step,parsingLogic)
    if not parsingLogic then
        parsingLogic = addon.functions
    end
    addon.step = step
    if addon.lastObjective and addon.lastObjective.step ~= step then
        addon.lastObjective = nil
    end
    if addon.lastElement and addon.lastElement.step ~= step then
        addon.lastElement = nil
    end

    local line = linetext
    local classtag
    line = line:gsub("%s*<<%s*(.+)", function(t)
        classtag = t
        return ""
    end)
    if classtag and not applies(classtag) then return end

    if step then
        local steptag, assignment, value = line:match("^#(%S+)%s*(=?)%s*(.*)")
        if steptag and steptag ~= "" then
            if not step[steptag] then
                if assignment == "=" then
                    step[steptag] = parsingLogic[value]
                else
                    step[steptag] = value
                end
            end
            return
        end
    end

    local element
    local text
    line = line:gsub("%s*>>%s*(.*)", function(t)
        if t ~= "" then text = t end
        return ""
    end)

    line:gsub("^%.(%S+)%s*(.*)", function(tag, args)
        local t = {}

        if addon.separators[tag] then
            addon.separators[tag](t,args)
        else
            args = args:gsub("%s*,%s*", ",")
            for arg in string.gmatch(args, "[^,]+") do
                tinsert(t, arg)
            end
        end
        -- print(tag,args,type(guide))
        if parsingLogic[tag] then
            element = parsingLogic[tag](linetext, text, unpack(t))
            if not element then return end
            element.tag = tag
            element.step = step
            if element.parent then
                element.parent = addon.lastObjective
            end
        else
            local ltext
            if #linetext > 150 then
                ltext = linetext:sub(1,150)
            else
                ltext = linetext
            end
            return addon.error(L("Error parsing guide") .. " " ..
                                   addon.currentGuideName ..
                                   ": Invalid function call (." .. tag ..
                                   ")\n" .. ltext)
        end
    end)

    if text and not element then
        element = {text = text, textOnly = true, step = step}
    elseif line:sub(1, 1) == "+" then
        element = {text = line:sub(2, -1), step = step}
        addon.lastObjective = element
    elseif line:sub(1, 1) == "*" then
        element = {
            text = line:sub(2, -1):gsub("\\n", "\n"),
            step = step,
            hideTooltip = true,
            textOnly = true
        }
        -- else
        -- error('Error parsing guide at line '..linenumber..'/ '..guide.name)
    end
    if element and (element.text and not element.textOnly or element.dynamicText) then
        addon.lastObjective = element
    end

    --[[if RXPData.localeTable and element and element.text then
        RXPData.localeTable[element.text] = ""
    end]]
    if not step then
        if element then
            element.parent = nil
        --[[else
            addon.error(L("Error parsing ") .. addon.currentGuideName .. ':'
                 .. linetext)
        ]]
        end
    elseif step.elements and element then
        tinsert(step.elements, element)
        addon.lastElement = element
    end
    return element
end
addon.ParseLine = parseLine

function addon.ParseGuide(groupOrContent, text, defaultFor, isEmbedded, group, key)

    addon.lastObjective = nil
    if not groupOrContent then return end

    local playerLevel = UnitLevel("player")
    local parentGroup
    local length
    if isEmbedded then
        length = groupOrContent:len()
    else
        length = groupOrContent:match("^%-%-(%d+)")
    end
    if not (groupOrContent and text) then
        local currentGroup = group
        if type(length) ~= "string" then
            text = groupOrContent:gsub("%-%-[^\r\n]*[\r\n]+", "\n")
        else
            text = groupOrContent
        end
        if not group then
            text = text:gsub(
                    "(#group[ \t]*)([^\r\n]-)[ \t]*<<[ \t]*([^\r\n]-)[ \t]*[\r\n]+",
                    function(prefix, group, t)
                    if not applies(t) then
                        return "\n"
                    else
                        currentGroup = group
                        return prefix .. group .. "\n"
                    end
                end)
        end
        if currentGroup then
            groupOrContent = currentGroup
        else
            groupOrContent = text:match("^%s*#group%s+(.-)%s*[\r\n]") or
                                 text:match("[\r\n]%s*#group%s+(.-)%s*[\r\n]")
            if not groupOrContent then
                addon.comms.PrettyDebug("\n%s: Invalid guide group %s",
                                        text:match("#name%s+.-%s*[\r\n]") or "", L("Error parsing guide") or "")
                return
            end
        end
    else
        text = text:gsub("%-%-[^\r\n]*[\r\n]", "\n")
    end

    local guide = {}
    if groupOrContent:sub(1, 1) == "+" then
        addon.farmGuides = addon.farmGuides + 1
        guide.farm = true
    end
    addon.guide = guide

    guide.group = groupOrContent
    addon.currentGuideGroup = groupOrContent

    local currentStep = 0
    guide.steps = {}

    local parsingLogic
    local step
    local skip
    local skipGuide
    local linenumber = 0
    local game = strlower(addon.game)
    local hasGameTag, isGameCompatible, hasGuideMetadata

    for line in string.gmatch(text, "[^\n\r]+") do
        linenumber = linenumber + 1
        line = line:gsub("^%s+", "")
        line = line:gsub("%s+$", "")
        -- print(line)
        if line:sub(1, 4) == "step" then
            if not addon.currentGuideName then
                error(L("Error parsing guide") .. ": " .. L("Guide has no name") .. "\n" .. text)
            end
            if currentStep == 0 then
                if guide.df then guide.retail = true end

                hasGameTag = guide.classic or guide.tbc or guide.wotlk or guide.df or guide.retail or guide.cata or guide.forever
                isGameCompatible = guide[game] or (addon.game == "FOREVER" and guide.classic or addon.game == "CLASSIC" and guide.forever)
                hasGuideMetadata = guide.name and guide.group

                if (hasGameTag and not isGameCompatible) or not hasGuideMetadata then
                    -- print(game,guide[game],guide.name)
                    skipGuide = "#0"
                end
                --debug purposes
                addon.lastGuideName = guide.name
                addon.lastGuideGroup = guide.group
            end
            if skipGuide then
                guide.version = tonumber(guide.version) or 0
                addon.minGuideVersion = math.min(guide.version,addon.minGuideVersion)
                addon.maxGuideVersion = math.max(guide.version,addon.maxGuideVersion)
                addon.guide = false
                addon.lastObjective = nil
                guide.key = guide.key or key
                return guide, skipGuide
            elseif currentStep == 0 then
                guide.key = guide.key or key or addon.BuildGuideKey(guide)
                guide.guideId = addon.A32(guide.key)
                addon.RegisterGroup(guide.group)
            end
            local classtag = line:match("<<%s*(.+)")
            if classtag and not applies(classtag) then
                skip = true
            else
                skip = false
                if step and step.elements and #step.elements == 0 then
                    step.hidewindow = true
                end
                currentStep = currentStep + 1
                guide.steps[currentStep] = {}
                guide.steps[currentStep].elements = {}
                step = guide.steps[currentStep]
                step.stepId = linenumber + guide.guideId
                --step.index = currentStep
                addon.step = step
                --addon.lastObjective = nil
                parsingLogic = addon.functions
            end
        elseif not skip then
            if currentStep > 0 then
                parseLine(line,step,parsingLogic)
            else
                -- print(line)
                line = line:gsub("(.-)%s*<<%s*(.+)", function(code, tag)
                    local isValid = applies(tag)
                    if #code == 0 then
                        skipGuide = not isValid and tag
                        guide.enabledFor = guide.enabledFor or tag
                        -- print("$"..code.."$",tag,#code)
                    elseif not isValid then
                        return ""
                    end
                    return code
                end)

                if line ~= "" then
                    line:gsub("^#(%S+)%s*(=?)%s*(.*)",
                              function(tag, assignment, value)
                        -- print(tag,string.len(tag))
                        if tag and tag ~= "" and not guide[tag] then
                            if assignment == "=" then
                                local func = addon.functions[value]
                                guide[tag] = func and func() or value
                            else
                                guide[tag] = value
                            end
                            if tag == "name" then
                                addon.currentGuideName = value
                            end
                        end
                    end)
                end
            end
        end
    end
    -- print(guide)
    addon.step = false
    if not guide.name then error(L('Guide has no name')) end

    defaultFor = guide.defaultfor or defaultFor
    guide.group = guide.group or groupOrContent
    groupOrContent = addon.GroupOverride(guide) or groupOrContent

    if addon.game == "TBC" and guide.classic and not guide.wotlk and not groupOrContent:find("TBC") and groupOrContent:sub(1,1) ~= "+" then
        if guide.subgroup then
            local range = guide.subgroup:match("( %d+%-%d+)$")
            if range then
                guide.subgroup = L"Classic"..range
            end
        end
        if groupOrContent:sub(1,8) == "RestedXP" then
            groupOrContent = addon.classicPrefix..groupOrContent
            guide.group = groupOrContent
        end
        defaultFor = "!tbc"
    end

    if addon.game == "CLASSIC" and guide.forever and not guide.classic then
        parentGroup = groupOrContent
        guide.lowPrio = "*" .. groupOrContent
    elseif defaultFor then
        local boost58
        if defaultFor == "58Boost" then
            if playerLevel >= 60 or playerLevel < 58 then
                parentGroup = groupOrContent
                guide.lowPrio = "*" .. groupOrContent
            end
            boost58 = true
        elseif not applies(defaultFor) then
            parentGroup = groupOrContent
            guide.lowPrio = "*" .. groupOrContent
        end
        addon.RegisterGroup(groupOrContent, parentGroup)
        guide.boost58 = boost58
        --guide.lowPrio = groupOrContent
    end

    guide.displayname = addon.settings.ReplaceColors(guide.displayname or guide.name)
    guide.name = guide.name:gsub("^(%d)-(%d%d?)", addon.affix)

    guide.key = addon.BuildGuideKey(guide)
    guide.version = tonumber(guide.version) or 0
    addon.minGuideVersion = math.min(guide.version,addon.minGuideVersion)
    addon.maxGuideVersion = math.max(guide.version,addon.maxGuideVersion)

    addon.guide = false
    addon.lastObjective = nil
    -- print(guide.name,"\n",guide.enabledFor)

    local metadata = {length = length}

    for k,v in pairs(guide) do
        if not (type(v) == "table" or type(v) == "function") then
            metadata[k] = v
        end
    end
    metadata.lowPrio = nil
    metadata.defaultFor = defaultFor
    return guide,nil,metadata
end

addon.groupAlias = {}
function addon.GroupOverride(guide,arg2)
    local guideTable = type(guide) == "table" and guide

    local function SwapGroup(grp,subgrp)
        local prefix = ""
        if grp:sub(1,1) == "*" then
            prefix = "*"
        end
        --local group,subgroup
        local swap
        if addon.game == "CLASSIC" or guideTable and guideTable.classic then
            local groupId = guideTable and guideTable.groupid
            local faction = not groupId and grp:match("RestedXP ([AH][lo][lr][id][ea]%w*)")
            if faction == "Alliance" or groupId == "RXP-SRGCE-A1" then
                subgrp = subgrp or grp
                if guideTable then
                    guideTable.groupdisplayname = prefix .. L"RestedXP Speedrun Guide (A)"
                end
                swap = true
                --print('\n',grp,subgrp,faction,type(guide) == "table" and guide.name,'\n')
            elseif faction == "Horde" or groupId == "RXP-SRGCE-H1" then
                subgrp = subgrp or grp
                if guideTable then
                    guideTable.groupdisplayname = prefix .. L"RestedXP Speedrun Guide (H)"
                end
                swap = true
                --print(group,guide.subgroup,faction,guide.group,guide.name)
            end
        elseif addon.game == "TBC" then
            if not guideTable or not guideTable.classic then
                local range = subgrp and subgrp:match("^RestedXP Survival.-( %d+%-%d+)$")
                if range then
                    subgrp = "TBC Survival Guide"..range
                    swap = true
                else
                    range = subgrp and subgrp:match("^RestedXP [AH][lo][lr][id][ea]%w*( %d+%-%d+)")
                    if range then
                        subgrp = "TBC Speedrun Guide"..range
                        swap = true
                    end
                end
                local SG = grp:match("^RestedXP Survival Guide(.*)")
                if SG then
                    swap = true
                    grp = "RXP TBC Survival Guide"..SG
                end
            end
        end
        return grp,subgrp,swap
    end

    if type(guide) == "table" then
        if guide.group then
        --if true then  return end
            local group,swap
            group, guide.subgroup,swap = SwapGroup(guide.group,guide.subgroup)
            if swap then
                addon.groupAlias[guide.group] = group
                guide.group = group
                guide.next = guide.next and guide.next:gsub("[^;]-\\","")
            end
            --print(group,'//',guide.subgroup)
            return group
        end
    elseif type(guide) == "string" then
        --print(guide,arg2)
        return SwapGroup(guide,arg2)
    else
        return guide
    end
end

if not _G.RXPGuides.RegisterGuide then
    _G.RXPGuides.RegisterGuide = addon.RegisterGuide
end

-- WF: removed the RXPGuides.ImportGuide global and the GuideImporter module (encrypted guide import)
