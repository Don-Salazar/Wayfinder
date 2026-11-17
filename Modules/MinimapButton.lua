-- Modules/MinimapButton.lua
-- Purpose: a plain minimap button that replaces LibDataBroker-1.1 +
-- LibDBIcon-1.0 (no longer loaded). addon.settings:UpdateMinimapButton
-- (SettingsPanel.lua) builds the same click/tooltip table it used to hand to
-- LibDataBroker and passes it to MinimapButton:Register. The button is 31x31,
-- parented to Minimap, draggable around the minimap edge; its angle is saved in
-- degrees in profile.minimap.minimapPos (the key LibDBIcon used, so existing
-- profiles keep their position). No frame exists until the
-- "Enable Minimap Button" option (profile.enableMinimapButton) is on.
-- Licence: CC BY-NC-SA 4.0, Wayfinder contributors
-- Date: 2026-11-17

local _, addon = ...

local MinimapButton = {}
addon.MinimapButton = MinimapButton

local DEFAULT_ANGLE = 146

local button -- created on first Register
local dataObject -- {icon, OnClick, OnTooltipShow}
local db -- profile.minimap

local function isEnabled()
    local profile = addon.settings and addon.settings.profile
    return profile and profile.enableMinimapButton and true or false
end

local function placeButton()
    local angle = math.rad(db and db.minimapPos or DEFAULT_ANGLE)
    local radius = Minimap:GetWidth() / 2 + 5
    button:ClearAllPoints()
    button:SetPoint("CENTER", Minimap, "CENTER", math.cos(angle) * radius, math.sin(angle) * radius)
end

local function onDragUpdate()
    local mx, my = Minimap:GetCenter()
    local cx, cy = GetCursorPosition()
    local scale = Minimap:GetEffectiveScale()
    cx, cy = cx / scale, cy / scale
    if db then db.minimapPos = math.deg(math.atan2(cy - my, cx - mx)) % 360 end
    placeButton()
end

local function onEnter(self)
    if not (dataObject and dataObject.OnTooltipShow) then return end
    GameTooltip:SetOwner(self, "ANCHOR_LEFT")
    dataObject.OnTooltipShow(GameTooltip)
    GameTooltip:Show()
end

local function onLeave()
    GameTooltip:Hide()
end

local function onClick(self, mouseButton)
    if dataObject and dataObject.OnClick then dataObject.OnClick(self, mouseButton) end
end

local function createButton()
    button = CreateFrame("Button", nil, Minimap)
    button:SetSize(31, 31)
    button:SetFrameStrata("MEDIUM")
    button:SetFrameLevel(8)
    button:RegisterForClicks("LeftButtonUp", "RightButtonUp")
    button:RegisterForDrag("LeftButton")
    button:SetHighlightTexture("Interface/Minimap/UI-Minimap-ZoomButton-Highlight")

    local icon = button:CreateTexture(nil, "ARTWORK")
    icon:SetSize(20, 20)
    icon:SetPoint("CENTER", button, "CENTER", 0, 1)
    button.icon = icon

    local border = button:CreateTexture(nil, "OVERLAY")
    border:SetSize(53, 53)
    border:SetPoint("TOPLEFT", button, "TOPLEFT")
    border:SetTexture("Interface/Minimap/MiniMap-TrackingBorder")

    button:SetScript("OnClick", onClick)
    button:SetScript("OnEnter", onEnter)
    button:SetScript("OnLeave", onLeave)
    button:SetScript("OnDragStart", function(self)
        self:SetScript("OnUpdate", onDragUpdate)
    end)
    button:SetScript("OnDragStop", function(self)
        self:SetScript("OnUpdate", nil)
    end)
end

-- data: {icon = texture, OnClick = function(frame, mouseButton),
--        OnTooltipShow = function(tooltip)}; settingsTable: profile.minimap.
-- Creates no frame while the option is off.
function MinimapButton:Register(data, settingsTable)
    dataObject = data
    db = settingsTable
    if not isEnabled() then
        self:Hide()
        return
    end
    if not Minimap then return end
    if not button then createButton() end
    button.icon:SetTexture(data and data.icon)
    placeButton()
    button:Show()
end

function MinimapButton:Hide()
    if button then button:Hide() end
end
