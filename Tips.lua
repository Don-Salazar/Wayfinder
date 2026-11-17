local addonName, addon = ...

if addon.gameVersion > 60000 then return end

local GetSpellInfo = C_Spell and C_Spell.GetSpellInfo and addon.GetSpellInfo or _G.GetSpellInfo
local GetSpellTexture = C_Spell and C_Spell.GetSpellTexture or _G.GetSpellTexture
local GetSpellSubtext = C_Spell and C_Spell.GetSpellSubtext or _G.GetSpellSubtext
local IsCurrentSpell = C_Spell and C_Spell.IsCurrentSpell or _G.IsCurrentSpell
local IsSpellKnown = C_Spell and C_Spell.IsSpellKnown or _G.IsSpellKnown
local IsPlayerSpell = C_Spell and C_Spell.IsPlayerSpell or _G.IsPlayerSpell
-- WF: breath-timer and health reads removed with the emergency/drowning tips (No combat logic, B18 C1/C2)
local GetTime = _G.GetTime
local HasAction, GetActionInfo, GetMacroSpell = HasAction, GetActionInfo, GetMacroSpell
local IsOnBarOrSpecialBar = C_ActionBar.IsOnBarOrSpecialBar
local tinsert, fmt = tinsert, string.format
local GetRealZoneText = GetRealZoneText
local UIErrorsFrame = _G.UIErrorsFrame
local STRING_ENVIRONMENTAL_DAMAGE_DROWNING = _G.STRING_ENVIRONMENTAL_DAMAGE_DROWNING
local L = addon.locale.Get

addon.tips = addon:NewModule("Tips", "AceEvent-3.0")

local session = {
    checkFrequency = 0.5,
    checkLast = GetTime(),
    lastAlert = 0,
    alertFrequency = 1,
    emergencyItems = {},
    emergencySpells = {},
    highlights = {},
    actionBarMap = {},
    dangerousMobs = {}
}

function addon.tips:Setup()
    if not addon.settings.profile.enableTips then return end

    self:CreateTipsFrame()
    self:CreateDangerWarning()

    -- WF: emergency-action (player health) and drowning (breath timer) tips removed: no MIRROR_TIMER_*,
    -- inventory/action-bar catalogue or WorldFrame OnUpdate poll (No combat logic, B18 C1/C2).
    -- The danger-warning frame stays for the targeting flash (Targeting.lua).

    if addon.dangerousMobs then
        self:LoadDangerousMobs()
        self:RegisterEvent("ZONE_CHANGED_NEW_AREA")
    end
end

function addon.tips:CreateTipsFrame()
    if not addon.settings.profile.enableTipsFrame then return end
    -- TODO
end

-- WF: removed the breath-timer handlers, the WorldFrame OnUpdate poll, the player-health check and the
-- emergency item/spell catalogue and highlights (No combat logic, B18 C1/C2).

function addon.tips:CreateDangerWarning()
    if self.dangerWarning then return end

    local f = CreateFrame("Frame", "RXPDangerFrame", UIParent, BackdropTemplateMixin and "BackdropTemplate")
    f:SetFrameStrata("FULLSCREEN_DIALOG")

    f:SetPoint('CENTER', UIParent, 'CENTER', 0, 1)
    f:SetAllPoints(nil)
    f.bg = f:CreateTexture(nil, 'BACKGROUND')
    f.bg:SetTexture("Interface\\FullScreenTextures\\LowHealth")
    f.bg:SetBlendMode('ADD')
    f.bg:SetAllPoints(nil)

    f.animation = f:CreateAnimationGroup()
    f.animation:SetLooping("BOUNCE")
    f.animation.pulse = f.animation:CreateAnimation("Alpha")
    f.animation.pulse:SetDuration(0.5236)
    f.animation.pulse:SetFromAlpha(0.75)
    f.animation.pulse:SetToAlpha(0.2)

    f:Hide()

    f.animation:HookScript("OnLoop", function()
        if f.doLoops < 0 then
            f:Hide()
            f.animation:Stop()
        end

        f.doLoops = f.doLoops - 1
    end)

    self.dangerWarning = f
end

function addon.tips:EnableDangerWarning(loops)
    if not self.dangerWarning or tonumber(loops) == nil then return end

    if loops > 0 then
        self.dangerWarning.doLoops = loops
        if not self.dangerWarning.animation:IsPlaying() then self.dangerWarning.animation:Play() end
        self.dangerWarning:Show()
    end
end

local function IsStepActive(self)
    local levelBuffer = 1000
    local profile = addon.settings.profile
    local active
    if addon.gameVersion < 40000 then
        active = profile.showDangerousMobsMap
    else
        active = profile.showRares and self.rare or profile.showTreasures and self.treasure
    end
    if (not active and self.mapTooltip) or (self.isUnitscan and not profile.showDangerousUnitscan) then
        -- DevTools_Dump(self.elements[1].unitscan)
        -- DevTools_Dump(self.elements[1].targets)
        return false
    elseif not profile.debug and self.levelBuffer then
        levelBuffer = self.levelBuffer or 0
    end
    if not self.MaxLevel or self.MaxLevel >= UnitLevel("player") - levelBuffer then return true end
end

function addon.tips:LoadDangerousMobs(reloadData)
    if not addon.dangerousMobs then return end

    local mapId = C_Map.GetBestMapForUnit("player") or 0
    local zone = addon.mapIdToName and addon.mapIdToName[mapId] or GetRealZoneText()
    local zoneList

    addon.UpdateMap()

    if not zone or not addon.dangerousMobs[zone] then zone = mapId end

    -- print(zone,addon.dangerousMobs[zone])
    if not addon.dangerousMobs[zone] then
        addon.tips.dangerousMobs = nil
        addon.generatedSteps["dangerousMobs"] = nil
        return
    end

    local dangerousMobs = session.dangerousMobs[zone] or {}
    session.dangerousMobs[zone] = dangerousMobs
    zoneList = zoneList or {addon.dangerousMobs[zone]}

    -- dangerousMobs DB has nested objects, flatten and fake step data
    if not dangerousMobs.processed or reloadData == true then
        addon.currentGuideName = L"Addon Tips"

        local steps = {}
        local step, element, skip, prefix

        for _, zoneData in pairs(zoneList) do
            for name, list in pairs(zoneData) do
                for _, mobData in ipairs(list) do
                    if not mobData.applies or addon.applies(mobData.applies) then
                        if type(name) == "number" then
                            name = fmt("npc:%s:%d", mobData.Name or "", name)
                        end
                        -- added a semicolon separator in case the database entry has multiple coords
                        for line in mobData.Location:gmatch("[^\r\n;]+") do
                            line:gsub("^%s+", "")
                            line:gsub("%s+$", "")

                            element = addon.ParseLine(line)
                            skip = false

                            if element then
                                step = {}

                                if element.tag == "rare" then step.rare = true end
                                if element.tag == "treasure" then step.treasure = true end
                                step.dangerousMob = true

                                element.step = step
                                -- element.drawCenterPoint = true--Adds an icon at the center of the lines
                                step.isActive = IsStepActive
                                step.levelBuffer = mobData.Classification == "Normal" and 1 or 3

                                if element.wx or element.segments then
                                    -- step.linethickness = 2
                                    step.showTooltip = true -- Shows tooltip when hovering over a line
                                    step.icon = mobData.Icon or "|TInterface/GossipFrame/BattleMasterGossipIcon:0|t" -- texture used for the icon
                                    step.alternateIcon = mobData.AltIcon
                                    prefix = ""

                                    if addon.gameVersion < 20000 then
                                        prefix = _G.VOICEMACRO_1_Sc_0
                                        step.mapTooltip = fmt("%s %s (%d)", prefix, name, mobData.MaxLevel) -- Tooltip title
                                    else
                                        step.mapTooltip = name -- Tooltip title
                                    end

                                    -- Tooltip description:
                                    if mobData.Movement then
                                        element.mapTooltip =
                                            fmt("%s - %s\n%s", mobData.Classification or "", mobData.Movement or "",
                                                mobData.Notes or "")
                                    else
                                        element.mapTooltip =
                                            fmt("%s\n%s", mobData.Classification or "", mobData.Notes or "")
                                    end
                                elseif element.targets or element.unitscan or element.mobs then
                                    if addon.settings.profile.showDangerousUnitscan then
                                        step.isUnitscan = true
                                    else
                                        skip = true
                                    end
                                end

                                if not skip then
                                    step.hideMinimap = true
                                    step.elements = {element}
                                    tinsert(steps, step)
                                end
                            end
                        end
                    end
                end
            end
        end

        addon.currentGuideName = nil
        dangerousMobs.steps = steps

        addon:ScheduleTask(addon.RegisterGeneratedSteps)
    end

    addon.generatedSteps["dangerousMobs"] = dangerousMobs.steps
    dangerousMobs.processed = true
    addon.tips.dangerousMobs = dangerousMobs
end

addon.tips.ZONE_CHANGED_NEW_AREA = addon.tips.LoadDangerousMobs
