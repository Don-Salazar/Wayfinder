<#
.SYNOPSIS
  Copy the Wayfinder addon into a WoW: Forever install for in-game testing.

.DESCRIPTION
  Builds the shipped addon first with tools/build-addon (the same checks as
  `npm run check:addon`): dist\Wayfinder holds Wayfinder.toc and every file it
  loads, Bindings.xml, LICENSE, NOTICE.md, the asset folders and bundled
  library licences (tools/build-toc/config.json), with the rename map
  tools/build-addon/rebrand.json applied so Wayfinder installs next to
  RestedXP's RXPGuides without collisions. Then copies dist\Wayfinder.
  Upstream's RXPGuides*.toc are never copied.

  Target: <WowRoot>\_forever_\Interface\AddOns\Wayfinder\
  - refuses to run if <WowRoot>\_forever_\Interface\AddOns does not exist;
  - refuses to run if Wayfinder.toc is stale (run `npm run build:toc`), or if
    the build, its residue check or its line-count check fails;
  - deletes the old Wayfinder folder first, and only that folder;
  - never touches any other addon folder (RXPGuides included).

  Usage (from anywhere; needs Node and `npm ci` done in the repo):
    powershell -ExecutionPolicy Bypass -File tools\dev\install.ps1
    powershell -ExecutionPolicy Bypass -File tools\dev\install.ps1 -WowRoot "D:\Games\World of Warcraft"

.PARAMETER WowRoot
  The World of Warcraft folder (the one that contains _forever_). Default: the
  "WoW install" row of docs\ENV.md.
#>
[CmdletBinding()]
param(
    [string]$WowRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Fail([string]$Message, [int]$Code) {
    [Console]::Error.WriteLine("install.ps1: $Message")
    exit $Code
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AddonName = 'Wayfinder'

if (-not $WowRoot) {
    $envDoc = Join-Path $Root 'docs\ENV.md'
    if (Test-Path -LiteralPath $envDoc) {
        foreach ($line in Get-Content -LiteralPath $envDoc -Encoding UTF8) {
            # | WoW install | `C:\Program Files (x86)\World of Warcraft` | ... |
            if ($line -match '^\|\s*WoW install\s*\|\s*`([^`]+)`') { $WowRoot = $Matches[1]; break }
        }
    }
    if (-not $WowRoot) {
        Fail 'No -WowRoot given and no "WoW install" row found in docs\ENV.md.' 2
    }
    Write-Host "WowRoot from docs\ENV.md: $WowRoot"
}

$AddOns = Join-Path $WowRoot '_forever_\Interface\AddOns'
if (-not (Test-Path -LiteralPath $AddOns -PathType Container)) {
    Fail "AddOns folder not found: $AddOns (is -WowRoot the folder that contains _forever_?)" 2
}
$AddOns = (Resolve-Path -LiteralPath $AddOns).Path
$Target = [System.IO.Path]::GetFullPath((Join-Path $AddOns $AddonName))

# Strict guard: we only ever delete or write <...>\Interface\AddOns\Wayfinder.
if ($Target -notmatch '\\Interface\\AddOns\\Wayfinder$' -or (Split-Path -Leaf $Target) -cne $AddonName) {
    Fail "Refusing to use target '$Target': it must end in \Interface\AddOns\$AddonName." 3
}

# Make sure Wayfinder.toc is current, build dist\Wayfinder, and ask the build tool what ships.
$Dist = Join-Path $Root 'dist\Wayfinder'
Push-Location $Root
try {
    $tsx = Join-Path $Root 'node_modules\tsx\dist\cli.mjs'
    if (-not (Test-Path -LiteralPath $tsx)) { Fail 'tsx not installed; run "npm ci" in the repo first.' 2 }
    & node $tsx 'tools/build-toc/index.ts' --check
    if ($LASTEXITCODE -ne 0) { Fail 'Wayfinder.toc is stale; run "npm run build:toc" first.' 4 }
    & node $tsx 'tools/build-addon/index.ts' --check-residue --check-lines
    if ($LASTEXITCODE -ne 0) { Fail 'build-addon failed (see above); nothing was installed.' 4 }
    $files = @(& node $tsx 'tools/build-toc/index.ts' --list-files)
    if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) { Fail 'build-toc --list-files failed.' 4 }
}
finally {
    Pop-Location
}

# Validate every path before touching the target.
foreach ($f in $files) {
    if ($f -match '(^|[\\/])\.\.([\\/]|$)' -or [System.IO.Path]::IsPathRooted($f)) {
        Fail "Refusing suspicious path from the file list: '$f'" 4
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Dist $f) -PathType Leaf)) {
        Fail "Listed file is missing in the build output ${Dist}: '$f'" 4
    }
}

if (Test-Path -LiteralPath $Target) {
    Write-Host "Removing old $Target"
    Remove-Item -LiteralPath $Target -Recurse -Force -Confirm:$false
}
New-Item -ItemType Directory -Path $Target | Out-Null

$counts = @{}
foreach ($f in $files) {
    $rel = $f -replace '/', '\'
    $dest = Join-Path $Target $rel
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item -LiteralPath (Join-Path $Dist $rel) -Destination $dest -Force
    $top = if ($rel.Contains('\')) { $rel.Split('\')[0] } else { '(root)' }
    if ($counts.ContainsKey($top)) { $counts[$top]++ } else { $counts[$top] = 1 }
}

Write-Host "Installed $($files.Count) files into $Target"
foreach ($k in ($counts.Keys | Sort-Object)) { Write-Host ("  {0,-10} {1,5}" -f $k, $counts[$k]) }
Write-Host 'Untested in client until you /reload in game.'
