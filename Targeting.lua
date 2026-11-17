local addonName, addon = ...

local fmt, tinsert, tremove, mmax, mmin, mrand = string.format, table.insert, table.remove, math.max, math.min,
                                                 math.random
local GetMacroInfo, CreateMacro, EditMacro, InCombatLockdown, GetNumMacros = GetMacroInfo, CreateMacro, EditMacro,
                                                                             InCombatLockdown, GetNumMacros
-- WF: TargetUnit local dropped with the proximity scan (B18 A1)
local next, IsInRaid, UnitIsDead, UnitIsGroupLeader, IsInGroup, UnitOnTaxi, UnitIsPlayer,
      UnitIsUnit = next, IsInRaid, UnitIsDead, UnitIsGroupLeader, IsInGroup, UnitOnTaxi,
                   UnitIsPlayer, UnitIsUnit
local GetRaidTargetIndex, SetRaidTarget = GetRaidTargetIndex, SetRaidTarget
local GetTime, FlashClientIcon, PlaySound = GetTime, FlashClientIcon, PlaySound
local wipe = wipe
local GetRealZoneText = GetRealZoneText
local GetNamePlates = C_NamePlate.GetNamePlates
local HBD = LibStub("HereBeDragons-2.0")

local GameTooltip = _G.GameTooltip

local L = addon.locale.Get

addon.targeting = addon:NewModule("Targeting", "AceEvent-3.0")
addon.targeting.macroName = "RXPTargeting"
addon.targeting.followMacroName = "RXPFollow"

local announcedTargets = {}
local macroTargets = {}
local lowPrioTargets = {}

-- WF: proxmityPolling state removed with the TargetUnit() proximity scan (B18 A1)

local targetList = {}
local targetPlaceholder = 2056011 -- Ui_chat

local mobList = {}
local mobPlaceholder = 135274 -- Inv_sword_04

local unitscanList = {}

local rareTargets = {}

local pendingLeaderUpdate

local UnitName = addon.GetUnitName

function addon.targeting:ConfigureTargetButton(button, targetName, kind, index, marking)
    local macrotext = "/cleartarget\n/targetexact " .. targetName

    -- Retail/Forever cannot SetRaidTarget automatically, leverage button
    if (addon.game == "FOREVER" or addon.gameVersion >= 120000) and marking then
        local markerIndex = self:GetMarkerIndex(kind, index)
        if markerIndex then
            -- Toggle Friendly markers
            -- Keep Mob/Unitscan markers
            -- >= 120000 requires ~N to prevent toggling
            -- Forever requires ~N to prevent toggling
            local markerPrefix = kind == "friendly" and "" or (addon.game == "FOREVER" and "!" or "~")
            macrotext = macrotext .. "\n/tm " .. markerPrefix .. markerIndex
        end
    end

    button:SetAttribute("type", "macro")
    button:SetAttribute("macrotext", macrotext)
end

function addon.targeting:Setup()
    if not addon.settings.profile.enableTargetMacro then DeleteMacro(self.macroName) end

    self:CreateTargetFrame()

    self:RegisterEvent("PLAYER_REGEN_ENABLED")

    -- Remove interacted target
    self:RegisterEvent("GOSSIP_SHOW")
    self:RegisterEvent("MERCHANT_SHOW")
    self:RegisterEvent("QUEST_PROGRESS")
    self:RegisterEvent("QUEST_GREETING")
    self:RegisterEvent("QUEST_COMPLETE")

    self:RegisterEvent("PLAYER_TARGET_CHANGED")
    self:RegisterEvent("UPDATE_MOUSEOVER_UNIT")

    if addon.settings.profile.createFollowMacro then
        self:RegisterEvent("PLAYER_ENTERING_WORLD")
        self:RegisterEvent("GROUP_FORMED")
        self:RegisterEvent("GROUP_LEFT")
        self:RegisterEvent("PARTY_LEADER_CHANGED")
    else
        DeleteMacro(self.followMacroName)
    end

    if not addon.settings.profile.enableTargetAutomation then return end

    -- TODO toggle without reloads

    -- Only works when nameplates are enabled
    self:RegisterEvent("NAME_PLATE_UNIT_ADDED")

    -- If enabled, increase nameplate scanning distance to max allowed
    if addon.settings.profile.enableMaxNameplateDistance then
        if addon.gameVersion > 40000 then
            SetCVar("nameplateMaxDistance", "100")
        else
            SetCVar("nameplateMaxDistance", "41")
        end
    end

    -- WF: removed the timer-driven TargetUnit() proximity scan, the ADDON_ACTION_FORBIDDEN listener, the
    -- StaticPopup hooks and UIParent:UnregisterEvent("ADDON_ACTION_FORBIDDEN"), and the rare loading that only
    -- that scan used (Protected actions need a player click, B18 A1/A2/H5).
end

function addon.targeting.GetCurrentTargets() return targetList, mobList, unitscanList, rareTargets end

local function shouldTargetCheck()
    return not IsInRaid() and not UnitOnTaxi("player") and not addon.isCastingHS and
               (next(unitscanList) ~= nil or next(mobList) ~= nil or next(targetList) ~= nil or next(rareTargets) ~= nil)
    -- WF: proximity scannedTargets term removed (B18 A1)

end

local currentTargets = ""
local function AnnounceTargets()
    if not addon.settings.profile.notifyOnTargetUpdates then return end

    addon.comms.PrettyPrint(L("Targeting macro updated with:%s"), currentTargets)
end

function addon.targeting:UpdateMacro(queuedTargets)
    if not addon.settings.profile.enableTargetMacro then return end
    if not shouldTargetCheck() then return end

    if InCombatLockdown() then
        macroTargets = queuedTargets or macroTargets
        return
    end

    local targets = queuedTargets or {}

    if not GetMacroInfo(self.macroName) then
        if not self:CanCreateMacro() then return end

        CreateMacro(self.macroName, "Ability_eyeoftheowl", "")
    end

    for _, t in ipairs(unitscanList) do if not lowPrioTargets[t] then tinsert(targets, t) end end

    for _, t in ipairs(mobList) do if not lowPrioTargets[t] then tinsert(targets, t) end end

    for _, t in ipairs(targetList) do if not lowPrioTargets[t] then tinsert(targets, t) end end

    for t in pairs(lowPrioTargets) do tinsert(targets, t) end

    -- Removes duplicate entries:
    local npcNames = {}
    local t
    for i = #targets, 1, -1 do
        t = targets[i]

        if npcNames[t] then
            targets[i] = false
        else
            npcNames[t] = true
        end
    end

    local content
    local targetText = ""
    for n = #targets, 1, -1 do
        t = targets[n]

        if t then
            if content then
                content = fmt('%s\n/targetexact %s', content, t)
            else
                content = fmt('/targetexact %s', t)
            end
            -- Prevent multiple spams
            if not (announcedTargets[t] or lowPrioTargets[t]) and addon.settings.profile.notifyOnTargetUpdates then
                targetText = fmt("%s %s,", targetText, t)
            end

            announcedTargets[t] = true

            if #content > 255 then content = content:gsub("^\n?[^\n]*[\n]*", "") end
        end
    end

    if #targetText > 0 then
        currentTargets = targetText:sub(1, -2)
        addon.ScheduleTask(1.5, AnnounceTargets)
    end

    local maxMacroSize = 230
    local targetMarker = ""
    if WOW_PROJECT_ID == WOW_PROJECT_CAMELOT or WOW_PROJECT_ID == WOW_PROJECT_MAINLINE then
        targetMarker = "\n/tm !7"
        maxMacroSize = 223
    end

    if content then
        while #content > maxMacroSize do content = content:gsub("^\n?[^\n]*[\n]*", "") end
        content = content .. targetMarker .. '\n/targetlasttarget [dead]'
    else
        content = fmt('//%s - %s', addon.title, L("current step has no configured targets")) -- TODO locale
    end

    EditMacro(self.macroName, self.macroName, nil, content)

    if not addon.settings.profile.macroAnnounced and addon.settings.profile.notifyOnTargetUpdates and next(targets) ~=
        nil then
        C_Timer.After(1, function()
            addon.comms.PrettyPrint(L(
                                        "A macro has been automatically built to aid in leveling. Please move %s to your action bars."),
                                    self.macroName)

        end)

        addon.settings.profile.macroAnnounced = true
    end

    macroTargets = {}
end

-- TODO fix bug when promoting leader
function addon.targeting:UpdateFollowMacro(leaderName)
    if not addon.settings.profile.createFollowMacro then return end

    if InCombatLockdown() then
        pendingLeaderUpdate = leaderName
        return
    end

    if not GetMacroInfo(self.followMacroName) then
        if not self:CanCreateMacro() then return end

        CreateMacro(self.followMacroName, "Inv_boots_02", "")
    end

    if not IsInGroup() or leaderName == "" then
        EditMacro(self.followMacroName, self.followMacroName, nil, "//" .. _G.ERR_QUEST_PUSH_NOT_IN_PARTY_S)

        return
    end

    if UnitIsGroupLeader("player") then
        EditMacro(self.followMacroName, self.followMacroName, nil, "//" .. _G.PARTY_LEADER)

        return
    end

    if not leaderName then leaderName = addon.comms.state.group.leader end

    if not leaderName then return end

    EditMacro(self.followMacroName, self.followMacroName, nil, fmt('/targetexact %s\n/follow\n', leaderName))

    pendingLeaderUpdate = nil
end

function addon.targeting:PLAYER_REGEN_ENABLED()
    if macroTargets then C_Timer.After(0.5, function() self:UpdateMacro(macroTargets) end) end

    self:UpdateTargetFrame()

    if pendingLeaderUpdate then C_Timer.After(mrand(1), function() self:UpdateFollowMacro(pendingLeaderUpdate) end) end
end

function addon.targeting:CheckNameplate(nameplateID)
    if not nameplateID then return end

    local unitName = UnitName(nameplateID)

    if not unitName then return end

    if addon.settings.profile.enableFriendlyTargeting then
        for i, name in ipairs(targetList) do
            if name == unitName then
                self:UpdateTargetFrame(nameplateID)

                if addon.settings.profile.enableTargetMarking then
                    self:UpdateMarker("friendly", nameplateID, i)
                end
            end
        end
    end

    if addon.settings.profile.enableEnemyTargeting then
        for i, name in ipairs(mobList) do
            if name == unitName then
                self:UpdateTargetFrame(nameplateID)

                if addon.settings.profile.enableMobMarking then self:UpdateMarker("mob", nameplateID, i) end
            end
        end

        for i, name in ipairs(unitscanList) do
            if name == unitName then
                self:UpdateTargetFrame(nameplateID)

                if addon.settings.profile.flashOnFind then FlashClientIcon() end

                if addon.settings.profile.enableTargetingFlash then addon.tips:EnableDangerWarning(1) end

                if addon.settings.profile.enableEnemyMarking then
                    self:UpdateMarker("unitscan", nameplateID, i)
                end
            end
        end
    end

    if addon.settings.profile.scanForRares then
        for _, name in ipairs(rareTargets) do
            if name == unitName then
                self:UpdateTargetFrame(nameplateID)

                if addon.settings.profile.flashOnFind then FlashClientIcon() end

                if addon.settings.profile.enableTargetingFlash then addon.tips:EnableDangerWarning(1) end

                if addon.settings.profile.enableEnemyMarking then
                    -- Steal moon, lowest of enemies for mark
                    self:UpdateMarker("rare", nameplateID, 4)
                end
            end
        end
    end
end

function addon.targeting:CheckNameplates()
    local nameplatesArray = GetNamePlates()

    if not nameplatesArray then return end

    for _, nameplate in ipairs(nameplatesArray) do self:CheckNameplate(nameplate.namePlateUnitToken) end
end

function addon.targeting:PLAYER_ENTERING_WORLD() C_Timer.After(mrand(3), function() self:UpdateFollowMacro() end) end

function addon.targeting:GROUP_FORMED() C_Timer.After(3 + mrand(2), function() self:UpdateFollowMacro() end) end

function addon.targeting:GROUP_LEFT() self:UpdateFollowMacro("") end

function addon.targeting:PARTY_LEADER_CHANGED() self:UpdateFollowMacro() end

function addon.targeting:NAME_PLATE_UNIT_ADDED(_, nameplateID)
    if not nameplateID or not shouldTargetCheck() then return end

    self:CheckNameplate(nameplateID)
end

function addon.targeting:UPDATE_MOUSEOVER_UNIT()
    if not shouldTargetCheck() then return end

    local kind = "mouseover"
    local unitName = UnitName(kind)

    if not unitName then return end

    if addon.settings.profile.enableFriendlyTargeting then
        for i, name in ipairs(targetList) do
            if name == unitName then
                self:UpdateTargetFrame(kind)

                if addon.settings.profile.enableTargetMarking then self:UpdateMarker("friendly", kind, i) end
            end
        end
    end

    if addon.settings.profile.enableEnemyTargeting then
        for i, name in ipairs(mobList) do
            if name == unitName then
                self:UpdateTargetFrame(kind)

                if addon.settings.profile.enableMobMarking then self:UpdateMarker("mob", kind, i) end
            end
        end

        for i, name in ipairs(unitscanList) do
            if name == unitName then
                self:UpdateTargetFrame(kind)

                if addon.settings.profile.flashOnFind then FlashClientIcon() end

                if addon.settings.profile.enableTargetingFlash then addon.tips:EnableDangerWarning(1) end

                if addon.settings.profile.enableEnemyMarking then self:UpdateMarker("unitscan", kind, i) end
            end
        end
    end

    if addon.settings.profile.scanForRares then
        for _, name in ipairs(rareTargets) do
            if name == unitName then
                self:UpdateTargetFrame(kind)

                if addon.settings.profile.flashOnFind then FlashClientIcon() end

                if addon.settings.profile.enableTargetingFlash then addon.tips:EnableDangerWarning(1) end

                if addon.settings.profile.enableEnemyMarking then
                    -- Steal moon, lowest of enemies for mark
                    self:UpdateMarker("rare", kind, 4)
                end
            end
        end
    end
end

function addon.targeting:PLAYER_TARGET_CHANGED()
    if not shouldTargetCheck() then return end

    local kind = "target"
    local unitName = UnitName(kind)

    if not unitName then return end

    if addon.settings.profile.enableFriendlyTargeting then
        for i, name in ipairs(targetList) do
            if name == unitName then
                self:UpdateTargetFrame(kind)

                if addon.settings.profile.enableTargetMarking then self:UpdateMarker("friendly", kind, i) end
            end
        end
    end

    if addon.settings.profile.enableEnemyTargeting then
        for i, name in ipairs(mobList) do
            if name == unitName then
                self:UpdateTargetFrame(kind)

                if addon.settings.profile.enableMobMarking then self:UpdateMarker("mob", kind, i) end
            end
        end

        for i, name in ipairs(unitscanList) do
            if name == unitName then
                self:UpdateTargetFrame(kind)

                if addon.settings.profile.enableEnemyMarking then self:UpdateMarker("unitscan", kind, i) end
            end
        end
    end

    if addon.settings.profile.scanForRares then
        for _, name in ipairs(rareTargets) do
            if name == unitName then
                self:UpdateTargetFrame(kind)

                if addon.settings.profile.flashOnFind then FlashClientIcon() end

                if addon.settings.profile.enableTargetingFlash then addon.tips:EnableDangerWarning(1) end

                if addon.settings.profile.enableEnemyMarking then
                    -- Steal moon, lowest of enemies for mark
                    self:UpdateMarker("rare", kind, 4)
                end
            end
        end
    end
end

function addon.targeting:GOSSIP_SHOW()
    if not addon.settings.profile.enableFriendlyTargeting then return end
    local targetUnit = UnitName("target")
    if not targetUnit then return end

    local targetIndex
    for i, name in ipairs(targetList) do
        if name == targetUnit then
            targetIndex = i
            break
        end
    end

    if not targetIndex then return end

    tremove(targetList, targetIndex)
    self:UpdateTargetFrame("target")
    self:UpdateMacro()

    if addon.game == "FOREVER" or addon.gameVersion >= 120000 then return end
    local marker = GetRaidTargetIndex("target")
    if not marker or addon.IsSecretValue(marker) then return end
    SetRaidTarget("target", 0)
end

addon.targeting.MERCHANT_SHOW = addon.targeting.GOSSIP_SHOW
addon.targeting.QUEST_PROGRESS = addon.targeting.GOSSIP_SHOW
addon.targeting.QUEST_GREETING = addon.targeting.GOSSIP_SHOW
addon.targeting.QUEST_COMPLETE = addon.targeting.GOSSIP_SHOW

-- WF: CheckTargetProximity (TargetUnit() on a ticker) and the ADDON_ACTION_FORBIDDEN handler removed (B18 A1/A2)

function addon.targeting:UpdateUnitList()
    local stepUnitscan = {}
    local stepMobs = {}
    local stepTargets = {}

    local function AddUnits(element, stepU, stepM, stepT)
        if element.unitscan then
            for _, t in ipairs(element.unitscan) do tinsert(stepU, addon.GetCreatureName(t)) end
        end

        if element.mobs then for _, t in ipairs(element.mobs) do tinsert(stepM, addon.GetCreatureName(t)) end end

        if element.targets then
            for _, t in ipairs(element.targets) do tinsert(stepT, addon.GetCreatureName(t)) end
        end
    end

    for _, step in pairs(addon.RXPFrame.activeSteps) do
        for _, element in pairs(step.elements or {}) do AddUnits(element, stepUnitscan, stepMobs, stepTargets) end
    end

    local unitscanGenerated = {}
    local mobsGenerated = {}
    local targetsGenerated = {}
    for generatedKind, context in pairs(addon.generatedSteps) do
        -- WF: dangerousMobs were only included with the removed proximity scan (B18 A1)
        if generatedKind ~= "dangerousMobs" then
            for _, step in ipairs(context) do
                for _, element in ipairs(step.elements or {}) do
                    AddUnits(element, unitscanGenerated, mobsGenerated, targetsGenerated)
                end
            end
        end
    end

    -- Update targets for macro
    addon.targeting:UpdateEnemyList(stepUnitscan, stepMobs)
    addon.targeting:UpdateTargetList(stepTargets)

    addon.targeting:UpdateEnemyList(unitscanGenerated, mobsGenerated, true)
    addon.targeting:UpdateTargetList(targetsGenerated, true)

    -- Don't process new targets if targeting disabled
    if addon.settings.profile.enableTargetAutomation then addon.targeting:CheckNameplates() end
end

local function FilterList(list)
    local u = {}
    local name

    for i, unit in pairs(list) do
        if unit:sub(1, 1) == "*" then
            name = unit:sub(2, -1)
            u[i] = name
        end
    end

    local size = #list

    for n = size, 1, -1 do if u[n] then table.remove(list, n) end end

    for n = 1, size do
        name = u[n]
        if name then table.insert(list, name) end
    end
end

function addon.targeting:UpdateTargetList(targets, addEntries)
    FilterList(targets)

    if addEntries then
        local update, found

        for _, unit in ipairs(targets) do
            found = false

            for _, src in ipairs(targetList) do
                if src == unit then
                    found = true
                    break
                end
            end

            if not found then
                update = true
                lowPrioTargets[unit] = true

                tinsert(targetList, unit)
            end
        end

        if not update then return end
    elseif addEntries == false then
        table.wipe(lowPrioTargets)
        targetList = targets
    else
        targetList = targets
    end

    self:UpdateMacro()

    if not addon.settings.profile.enableTargetFrame then return end

    -- WF: proximity-scan match reset removed (B18 A1)

    self:UpdateTargetFrame()
end

function addon.targeting:UpdateEnemyList(unitscan, mobs, addEntries)
    FilterList(unitscan)
    FilterList(mobs)

    if addEntries then
        local update, found

        for _, unit in ipairs(unitscan) do
            found = false

            for _, src in ipairs(unitscanList) do
                if src == unit then
                    found = true
                    break
                end
            end

            if not found then
                update = true
                tinsert(unitscanList, unit)
                lowPrioTargets[unit] = true
            end
        end

        for _, unit in ipairs(mobs) do
            found = false
            for _, src in ipairs(mobList) do
                if src == unit then
                    found = true
                    break
                end
            end
            if not found then
                tinsert(mobList, unit)
                update = true
                lowPrioTargets[unit] = true
            end
        end
        if not update then return end
    elseif addEntries == false then
        table.wipe(lowPrioTargets)
        unitscanList = unitscan
        mobList = mobs
    else
        unitscanList = unitscan
        mobList = mobs
    end

    self:UpdateMacro()

    if not addon.settings.profile.enableTargetFrame then return end

    -- WF: proximity-scan match reset removed (B18 A1)

    self:UpdateTargetFrame()
end

function addon.targeting:CanCreateMacro() return GetNumMacros() < 119 end

local function UpdateV1IconFrameVisuals(self)
    self:SetScale(addon.settings.profile.activeTargetScale or 1)

    addon.targeting:RenderTargetFrameBackground()

    self.title:ClearBackdrop()
    self.title:SetBackdrop(addon.RXPFrame.backdrop.edge)
    self.title:SetBackdropColor(unpack(addon.colors.background))

    self.title.text:SetFont(addon.font, 9, "")
    self.title.text:SetTextColor(unpack(addon.activeTheme.textColor))

    self.title:SetSize(self.title.text:GetStringWidth() + 10, 19)
end

local function UpdateV2IconFrameVisuals(self)
    local theme = addon.v2:GetTheme()

    self:SetScale(addon.settings.profile.activeTargetScale or 1)

    addon.targeting:RenderTargetFrameBackground()
    addon.ui.v2:ApplyFrameBackdrop(self.title, theme.edge, theme.backgroundColors.common, theme.borderColors.commonEdge)

    self.title.text:SetFont(addon.font, 9, "")
    self.title.text:SetTextColor(unpack(theme.textColor.title))

    self.title:SetSize(self.title.text:GetStringWidth() + 10, 19)
end

function addon.targeting:CreateTargetFrame()
    -- Still create frame even if targeting disabled, for frame location preservation
    if self.activeTargetFrame then return end

    self.activeTargetFrame = CreateFrame("Frame", "RXPTargetFrame", UIParent,
                                         BackdropTemplateMixin and "BackdropTemplate" or nil)
    local f = self.activeTargetFrame
    f.v2 = addon.v2:IsGuideWindowEnabled()

    f:SetClampedToScreen(true)
    f:EnableMouse(true)
    f:SetMovable(true)
    f:Hide()

    addon.enabledFrames["activeTargetFrame"] = f
    f.IsFeatureEnabled = function()
        if not addon.settings.profile.enableTargetFrame then return nil, true end
        if (self.activeTargetCount or 0) == 0 then return nil, true end

        -- WF: proximity-scan branch removed (B18 A1)
        return shouldTargetCheck(), true
    end

    self:RenderTargetFrameBackground()

    f.onMouseDown = function()
        if addon.settings.profile.lockFrames and not IsAltKeyDown() then return end
        f:StartMoving()
    end

    function f.onMouseUp()
        f:StopMovingOrSizing()
        addon.settings:SaveFramePositions()
    end

    f:SetScript("OnMouseDown", f.onMouseDown)
    f:SetScript("OnMouseUp", f.onMouseUp)
    f.friendlyTargetButtons = {}
    f.enemyTargetButtons = {}

    f:SetPoint("CENTER", UIParent, "CENTER", 0, 0)

    f.title = CreateFrame("Frame", "$parent_title", f, BackdropTemplateMixin and "BackdropTemplate" or nil)
    f.title:SetPoint("TOPLEFT", f, 5, 8)
    f.title:SetFrameLevel(f:GetFrameLevel() + 3)
    f.title.text = f.title:CreateFontString(nil, "OVERLAY")
    f.title.text:ClearAllPoints()
    f.title.text:SetPoint("CENTER", f.title, 0, 0)
    f.title.text:SetJustifyH("CENTER")
    f.title.text:SetJustifyV("MIDDLE")
    f.title.text:SetFont(addon.font, 9, "")
    f.title.text:SetText(L "Active Targets")

    f.title:EnableMouse(true)
    f.title:SetScript("OnMouseDown", f.onMouseDown)
    f.title:SetScript("OnMouseUp", f.onMouseUp)

    f.UpdateVisuals = f.v2 and UpdateV2IconFrameVisuals or UpdateV1IconFrameVisuals
    f:SetHeight(40)
    f:UpdateVisuals()
end

function addon.targeting:RenderTargetFrameBackground()
    if not self.activeTargetFrame then return end

    local f = self.activeTargetFrame
    if not f.v2 then
        if addon.settings.profile.hideActiveTargetsBackground then
            f:ClearBackdrop()
        else
            f:ClearBackdrop()
            f:SetBackdrop(addon.RXPFrame.backdrop.edge)
            f:SetBackdropColor(unpack(addon.colors.background))
        end
        return
    end

    if addon.settings.profile.hideActiveTargetsBackground then
        addon.ui.v2:SetFrameBackdropShown(f, false)
    else
        local theme = addon.v2:GetTheme()
        addon.ui.v2:ApplyFrameBackdrop(f, theme.edge, theme.backgroundColors.common, theme.borderColors.commonEdge)
        addon.ui.v2:AddFrameShadow(f)
        addon.ui.v2:SetFrameBackdropShown(f, true)
    end
end

local fOnEnter = function(self)
    if self:IsForbidden() or GameTooltip:IsForbidden() or not self.targetData then return end

    GameTooltip:ClearLines()
    GameTooltip:SetOwner(self, "ANCHOR_BOTTOM", 0, 0)

    if self.targetData.kind == "friendly" then
        GameTooltip:AddLine(self.targetData.name, 0, 1, 0)
    else
        GameTooltip:AddLine(self.targetData.name, 1, 0, 0)
    end

    GameTooltip:Show()
end

local fOnLeave = function(self)
    if self:IsForbidden() or _G.GameTooltip:IsForbidden() then return end

    GameTooltip:Hide()
end

function addon.targeting:GetMarkerIndex(kind, kindIndex)
    local raidTargetIndex

    if IsInGroup() and addon.settings.profile.enableNonLeadMarking and addon.comms.state.group.hasRXP then
        -- Overwrite kindIndex if party, works best for 1-3 RXP members
        --- player: star and skull
        --- party1: circle and cross
        --- party2: diamond and square
        --- party3: triangle and skull
        --- party4: star and cross
        kindIndex = addon.comms.state.group.members[addon.player.name].markerIndex
    end

    -- kindIndex is always >= 1, but to preserve modulus do -1
    kindIndex = kindIndex - 1

    if kind == 'friendly' then
        -- Use star 1, circle 2, diamond 3, and triangle 4
        -- 0 % 4 = 0 + 1, 3 % 4 = 3 + 1, 4 % 4 = 0 + 1, 5 % 4 = 1 + 1
        raidTargetIndex = (kindIndex % 4) + 1
    elseif kind == 'unitscan' or kind == 'rare' then
        -- Use moon 5
        -- Use Moon for all party members
        raidTargetIndex = 5
    elseif kind == 'mob' then
        -- Use skull 8, cross 7, square 6
        -- 0 % 3 = 8 - 0, 2 % 3 = 8 - 2
        raidTargetIndex = 8 - (kindIndex % 3)
    end

    return raidTargetIndex
end

function addon.targeting:UpdateMarker(kind, unitId, index)
    -- WF: return before the unit dead-state read on Forever; marking was already unreachable here (B18 A10/C9e)
    if addon.game == "FOREVER" then return end
    if (UnitIsDead(unitId) and kind ~= 'friendly') or UnitIsPlayer(unitId) or UnitIsUnit(unitId, "pet") then return end

    if IsInGroup() and not UnitIsGroupLeader('player') then
        if not addon.settings.profile.enableNonLeadMarking then return end
    end
    if addon.game == "FOREVER" or addon.gameVersion >= 120000 then return end
    local markerId = self:GetMarkerIndex(kind, index)

    local currentMarker = GetRaidTargetIndex(unitId)
    if not addon.IsSecretValue(currentMarker) and currentMarker == nil and markerId then
        SetRaidTarget(unitId, markerId)
    end
end

addon.targeting.portraitCache = {}
addon.targeting.activeIcons = {}
local iconCounter = 0

local function GetIcon(unit)
    local texture = addon.targeting.portraitCache[unit]
    local time = GetTime()

    if not texture then
        if iconCounter < 30 then
            texture = addon.targeting.activeTargetFrame:CreateTexture()
            iconCounter = iconCounter + 1
        else
            local lastActive = time
            local oldest
            local name

            for u, f in pairs(addon.targeting.portraitCache) do
                if f.lastActive < lastActive then
                    lastActive = f.lastActive
                    oldest = f
                    name = u
                end
            end

            addon.targeting.portraitCache[name] = nil
            texture = oldest
        end
    end

    addon.targeting.portraitCache[unit] = texture

    texture.unit = unit
    texture.lastActive = time

    return texture
end

local function GetUnitTexture(self, name, unit)
    local f = addon.targeting.portraitCache[name]

    if f and f.anchor then f.anchor:Show() end

    -- unit = unit or 'target'

    if unit and name and UnitName(unit) == name then
        f = GetIcon(name)

        SetPortraitTexture(f, unit)
    end

    if f then
        -- self.placeholder:Hide()
        f.anchor = self.placeholder

        addon.targeting.activeIcons[f] = true

        f:SetParent(self)
        f:SetAllPoints(self)
        f:Show()

        self.placeholder:Hide()
        self.icon = f

        return f
    else
        self.placeholder:Show()

        self.icon = self.placeholder

        return self.placeholder
    end
end

local buttonsPerRow = 4
local function GetTargetGridMetrics(count, rightPadding)
    return count > 0 and mmin(count, buttonsPerRow) * 27 + rightPadding or 0, ceil(count / buttonsPerRow)
end

local function RowifyTargets(targetFrame, btn, buttons, kind)
    local buttonKindCount = #buttons

    btn:ClearAllPoints()

    -- isNewRow == 0 when new row
    local isNewRow = (buttonKindCount - 1) % buttonsPerRow

    if buttonKindCount == 1 then
        if kind == "enemy" then
            btn:SetPoint("TOPLEFT", targetFrame, "TOPLEFT", 6, -15)
        else -- Friendly
            btn:SetPoint("BOTTOMLEFT", targetFrame, "BOTTOMLEFT", 6, 6)
        end

        return
    end

    if kind == "enemy" then
        if isNewRow == 0 then
            btn:SetPoint("TOP", buttons[buttonKindCount - buttonsPerRow], "BOTTOM", 0, 0)
        else
            btn:SetPoint("CENTER", buttons[buttonKindCount - 1], "CENTER", 27, 0)
        end
    else -- Friendly, build from bottom up to simplify height logic
        if isNewRow == 0 then
            btn:SetPoint("BOTTOM", buttons[buttonKindCount - buttonsPerRow], "TOP", 0, 0)
        else
            btn:SetPoint("CENTER", buttons[buttonKindCount - 1], "CENTER", 27, 0)
        end
    end
end

local function ResizeTargetsFrame(targetFrame, friendlyCount, enemyCount)
    local enemyWidth, enemyRows = GetTargetGridMetrics(enemyCount, 10)
    local friendlyWidth, friendlyRows = GetTargetGridMetrics(friendlyCount, 10)
    local soloFriendlyRow = enemyRows == 0 and friendlyRows == 1
    local contentOffset = targetFrame.v2 and 0 or 3

    targetFrame:SetWidth(mmax(targetFrame.title:GetWidth() + 10, friendlyWidth, enemyWidth))
    targetFrame:SetHeight(18 + (enemyRows + friendlyRows) * 25 + (enemyRows > 0 and friendlyRows > 0 and 5 or 0))

    if enemyRows > 0 then
        local firstEnemyButton = targetFrame.enemyTargetButtons[1]
        firstEnemyButton:ClearAllPoints()
        firstEnemyButton:SetPoint("TOPLEFT", targetFrame, "TOPLEFT", 6, -15 + contentOffset)
    end

    if friendlyRows > 0 then
        local firstFriendlyButton = targetFrame.friendlyTargetButtons[1]
        firstFriendlyButton:ClearAllPoints()
        firstFriendlyButton:SetPoint("BOTTOMLEFT", targetFrame, "BOTTOMLEFT", 6,
                                    (soloFriendlyRow and 4 or 6) + contentOffset)
    end
end

function addon.targeting:UpdateTargetFrame(selector)
    if not addon.settings.profile.enableTargetFrame then return end

    local targetFrame = self.activeTargetFrame

    if InCombatLockdown() then return end

    local enemyTargetButtons = targetFrame.enemyTargetButtons
    local enemyTargetButtonIndex = 0
    local enemiesList = {}

    -- WF: proximity scan removed (B18 A1); always show all, as upstream did with proximity off
    for _, n in ipairs(unitscanList) do enemiesList[n] = 'unitscan' end

    for _, n in ipairs(mobList) do enemiesList[n] = 'mob' end

    for frame in pairs(addon.targeting.activeIcons) do
        frame:Hide()

        if frame.anchor then
            frame.anchor:Show()
            frame.anchor = nil
        end
    end

    table.wipe(addon.targeting.activeIcons)

    local btn, icon, ht
    for targetName, enemyKind in pairs(enemiesList) do

        enemyTargetButtonIndex = enemyTargetButtonIndex + 1
        btn = enemyTargetButtons[enemyTargetButtonIndex]

        if not btn then
            btn = CreateFrame("Button", "RXPTargetFrame_EnemyButton" .. enemyTargetButtonIndex, targetFrame,
                              "SecureActionButtonTemplate")

            btn:SetAttribute("type", "macro")
            btn:SetSize(25, 25)

            if btn.RegisterForClicks then btn:RegisterForClicks("AnyUp", "AnyDown") end

            tinsert(enemyTargetButtons, btn)

            RowifyTargets(targetFrame, btn, enemyTargetButtons, "enemy")

            btn.icon = btn:CreateTexture(nil, "BACKGROUND")
            btn.placeholder = btn.icon
            btn.placeholder.isDefault = true
            btn.GetUnitTexture = GetUnitTexture

            icon = btn.icon

            icon.isDefault = true
            icon:SetAllPoints(true)
            icon:SetTexture(mobPlaceholder)

            btn:SetScript("OnEnter", fOnEnter)
            btn:SetScript("OnLeave", fOnLeave)

            ht = btn:CreateTexture(nil, "HIGHLIGHT")

            ht:SetAllPoints(true)
            ht:SetTexture("Interface\\Buttons\\ButtonHilight-Square")
            ht:SetBlendMode("ADD")
        end

        self:ConfigureTargetButton(btn, targetName, enemyKind, enemyTargetButtonIndex,
            addon.settings.profile.enableEnemyMarking)

        if btn.targetData and btn.targetData.name ~= targetName then
            btn.placeholder:SetTexture(mobPlaceholder)
            btn.placeholder.isDefault = true
        end

        btn:GetUnitTexture(targetName, selector)
        btn.targetData = {name = targetName, kind = enemyKind}

        -- If target or mouseover, set portrait
        if selector and UnitName(selector) == targetName and btn.icon.isDefault then
            SetPortraitTexture(btn.placeholder, selector)
            btn.placeholder.isDefault = false
        end

        btn:Show()
    end

    local friendlyTargetButtons = targetFrame.friendlyTargetButtons
    local friendlyTargetButtonIndex = 0
    -- WF: proximity scan removed (B18 A1); always show all
    local friendlyList = targetList

    for _, targetName in ipairs(friendlyList) do
        friendlyTargetButtonIndex = friendlyTargetButtonIndex + 1
        btn = friendlyTargetButtons[friendlyTargetButtonIndex]

        if not btn then
            btn = CreateFrame("Button", "RXPTargetFrame_FriendlyButton" .. friendlyTargetButtonIndex, targetFrame,
                              "SecureActionButtonTemplate")
            btn:SetAttribute("type", "macro")
            btn:SetSize(25, 25)

            if btn.RegisterForClicks then btn:RegisterForClicks("AnyUp", "AnyDown") end

            tinsert(friendlyTargetButtons, btn)

            RowifyTargets(targetFrame, btn, friendlyTargetButtons, "friendly")

            btn.icon = btn:CreateTexture(nil, "BACKGROUND")

            icon = btn.icon

            btn.placeholder = icon

            icon.isDefault = true
            icon:SetAllPoints(true)
            icon:SetTexture(targetPlaceholder)

            btn.GetUnitTexture = GetUnitTexture
            btn:SetScript("OnEnter", fOnEnter)
            btn:SetScript("OnLeave", fOnLeave)

            ht = btn:CreateTexture(nil, "HIGHLIGHT")

            ht:SetAllPoints(true)
            ht:SetTexture("Interface\\Buttons\\ButtonHilight-Square")
            ht:SetBlendMode("ADD")
        end

        self:ConfigureTargetButton(btn, targetName, "friendly", friendlyTargetButtonIndex,
            addon.settings.profile.enableTargetMarking)

        if btn.targetData and btn.targetData.name ~= targetName then
            btn.placeholder:SetTexture(targetPlaceholder)
            btn.placeholder.isDefault = true
        end

        btn:GetUnitTexture(targetName, selector)

        btn.targetData = {name = targetName, kind = "friendly"}

        -- If target or mouseover, set portrait
        if selector and btn.placeholder.isDefault and UnitName(selector) == targetName then
            SetPortraitTexture(btn.placeholder, selector)
            btn.placeholder.isDefault = false
        end

        btn:Show()
    end

    if friendlyTargetButtonIndex > 0 or enemyTargetButtonIndex > 0 then targetFrame:SetAlpha(1) end

    for f = friendlyTargetButtonIndex + 1, #friendlyTargetButtons do
        friendlyTargetButtons[f]:Hide()
        friendlyTargetButtons[f].placeholder:SetTexture(targetPlaceholder)
        friendlyTargetButtons[f].icon.isDefault = true
    end

    for e = enemyTargetButtonIndex + 1, #enemyTargetButtons do
        enemyTargetButtons[e]:Hide()
        enemyTargetButtons[e].placeholder:SetTexture(mobPlaceholder)
        enemyTargetButtons[e].icon.isDefault = true
    end

    self.activeTargetCount = friendlyTargetButtonIndex + enemyTargetButtonIndex

    ResizeTargetsFrame(targetFrame, friendlyTargetButtonIndex, enemyTargetButtonIndex)

    if (friendlyTargetButtonIndex == 0 and enemyTargetButtonIndex == 0) or not addon.settings.profile.showEnabled then
        targetFrame:Hide()
    else -- WF: proximity-scan branch removed (B18 A1)
        targetFrame:Show()
    end
end

-- WF: ZONE_CHANGED_NEW_AREA handler and LoadRares removed: rares were loaded only for the removed
-- TargetUnit() proximity scan (B18 A1)

function addon.ResetTargetPosition()
    local f = _G.RXPTargetFrame

    f:ClearAllPoints()
    f:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
end
