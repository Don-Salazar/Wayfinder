-- Modules/MenuCompat.lua
-- Purpose: show upstream's EasyMenu-style menu tables without LibUIDropDownMenu
-- (GPL, no longer loaded). addon:ShowMenu / addon:CloseMenu (RXPGuides.lua)
-- call into this when the client has no global EasyMenu.
-- Which menu API the Forever client offers is untested in client, so every
-- call feature-detects, in this order:
--   1. MenuUtil.CreateContextMenu (modern Blizzard menu; shown at the cursor)
--   2. the global EasyMenu
--   3. the globals UIDropDownMenu_Initialize + ToggleDropDownMenu +
--      UIDropDownMenu_AddButton
--   4. none of them: no error, one chat line per session.
-- Licence: CC BY-NC-SA 4.0, Wayfinder contributors
-- Date: 2026-11-17

local addonName, addon = ...

local MenuCompat = {}
addon.MenuCompat = MenuCompat

local warned = false

local function warnOnce()
    if warned then return end
    warned = true
    print(addonName .. " (debug): no menu API found (MenuUtil, EasyMenu, UIDropDownMenu); menu not shown.")
end

-- Closes whichever menu system is present. Never errors.
function MenuCompat.Close()
    local menu = _G.Menu
    if menu and menu.GetManager then
        local manager = menu.GetManager()
        if manager and manager.CloseMenus then manager:CloseMenus() end
    end
    if _G.CloseDropDownMenus then _G.CloseDropDownMenus() end
end

-- Stand-in for the dropdown button that upstream menu callbacks receive as
-- `self` (they read .value/.arg1/.arg2/.checked and call :Hide()).
local function buttonProxy(item)
    return {
        value = item.value,
        arg1 = item.arg1,
        arg2 = item.arg2,
        checked = item.checked,
        Hide = function() MenuCompat.Close() end,
    }
end

local function isChecked(item)
    local checked = item.checked
    if type(checked) == "function" then checked = checked(buttonProxy(item)) end
    return checked and true or false
end

local function displayText(item)
    local text = item.text or ""
    if item.colorCode then text = item.colorCode .. text .. "|r" end
    if item.icon then text = "|T" .. tostring(item.icon) .. ":0|t " .. text end
    return text
end

local function clickResponse(item)
    local responses = _G.MenuResponse
    if not responses then return nil end
    if item.keepShownOnClick then return responses.Refresh end
    return responses.CloseAll
end

local function addTooltip(description, item)
    if not (item.tooltipTitle and description.SetTooltip) then return end
    description:SetTooltip(function(tooltip)
        tooltip:SetText(item.tooltipTitle)
        if item.tooltipText then tooltip:AddLine(item.tooltipText, 1, 1, 1, true) end
    end)
end

-- Adds one EasyMenu-style item table to a MenuUtil element description.
local function addItem(parent, item)
    if not item.text then return end

    if item.isTitle then
        if item.text == "" then
            parent:CreateDivider()
        else
            parent:CreateTitle(displayText(item))
        end
        return
    end

    local description
    if item.hasArrow and type(item.menuList) == "table" then
        description = parent:CreateButton(displayText(item))
        for _, child in ipairs(item.menuList) do addItem(description, child) end
    elseif item.notCheckable then
        description = parent:CreateButton(displayText(item), function()
            if item.func then item.func(buttonProxy(item), item.arg1, item.arg2) end
            return clickResponse(item)
        end)
    else
        description = parent:CreateCheckbox(displayText(item),
            function() return isChecked(item) end,
            function()
                local nowChecked = not isChecked(item)
                if item.func then item.func(buttonProxy(item), item.arg1, item.arg2, nowChecked) end
                return clickResponse(item)
            end)
    end

    if description then
        if item.disabled and description.SetEnabled then description:SetEnabled(false) end
        addTooltip(description, item)
    end
end

local function showWithMenuUtil(menuUtil, menu, menuFrame)
    menuUtil.CreateContextMenu(menuFrame or _G.UIParent, function(_, rootDescription)
        for _, item in ipairs(menu) do addItem(rootDescription, item) end
    end)
end

local function showWithDropDown(menu, menuFrame, anchor, x, y, displayMode, autoHideDelay)
    local initialize = function(_, level, menuList)
        for index = 1, #menuList do
            local item = menuList[index]
            if item.text then
                item.index = index
                _G.UIDropDownMenu_AddButton(item, level)
            end
        end
    end
    if displayMode == "MENU" then menuFrame.displayMode = displayMode end
    _G.UIDropDownMenu_Initialize(menuFrame, initialize, displayMode, nil, menu)
    _G.ToggleDropDownMenu(1, nil, menuFrame, anchor, x, y, menu, nil, autoHideDelay)
end

-- Same arguments as Blizzard's EasyMenu. Never errors when no API exists.
function MenuCompat.Show(menu, menuFrame, anchor, x, y, displayMode, autoHideDelay)
    if type(menu) ~= "table" then return end

    local menuUtil = _G.MenuUtil
    if menuUtil and menuUtil.CreateContextMenu then
        return showWithMenuUtil(menuUtil, menu, menuFrame)
    end

    if _G.EasyMenu then
        return _G.EasyMenu(menu, menuFrame, anchor, x, y, displayMode, autoHideDelay)
    end

    if menuFrame and _G.UIDropDownMenu_Initialize and _G.ToggleDropDownMenu and _G.UIDropDownMenu_AddButton then
        return showWithDropDown(menu, menuFrame, anchor, x, y, displayMode, autoHideDelay)
    end

    warnOnce()
end
