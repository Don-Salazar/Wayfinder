<#
.SYNOPSIS
  Run luacheck, then busted, using only the toolchain in .tools\.

.DESCRIPTION
  Provision the toolchain first with tools\dev\setup-lua.ps1. PATH is
  changed for this process only. Both checks always run; the script exits
  non-zero if either fails.

  Usage (from anywhere):
    powershell -ExecutionPolicy Bypass -File tools\dev\lua-checks.ps1
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Root   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Tools  = Join-Path $Root '.tools'
$LuaBin = Join-Path $Tools 'lua51\bin'
$W64Bin = Join-Path $Tools 'w64devkit-2.11.0\w64devkit\bin'

foreach ($exe in 'lua.exe', 'luacheck.bat', 'busted.bat') {
    if (-not (Test-Path (Join-Path $LuaBin $exe))) {
        Write-Error "$exe not found in $LuaBin. Run tools\dev\setup-lua.ps1 first."
        exit 2
    }
}

# Only .tools binaries: put them first and drop nothing else we rely on.
# Clear inherited Lua search paths so no other Lua install leaks in.
$env:PATH = "$LuaBin;$W64Bin;$env:PATH"
Remove-Item Env:LUA_PATH, Env:LUA_CPATH, Env:LUA_INIT -ErrorAction SilentlyContinue

# luacheck and busted both expect the repo root as working directory
# (.luacheckrc and .busted are found there).
Push-Location $Root
try {
    $failed = @()

    # Parallel run when LuaLanes is installed (setup-lua.ps1 installs it);
    # the cache file speeds up re-runs and lives in the ignored .tools\.
    $lcArgs = @('.', '--cache', (Join-Path $Tools 'luacheck-cache'))
    $ErrorActionPreference = 'Continue'
    & (Join-Path $LuaBin 'lua.exe') -e 'require([[lanes]])' 2>$null
    $hasLanes = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = 'Stop'
    if ($hasLanes) { $lcArgs += @('-j', [string][Environment]::ProcessorCount) }

    Write-Host "==> luacheck $($lcArgs -join ' ')" -ForegroundColor Cyan
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & (Join-Path $LuaBin 'luacheck.bat') @lcArgs
    $lcExit = $LASTEXITCODE
    Write-Host ("luacheck exit {0} in {1:N1}s" -f $lcExit, $sw.Elapsed.TotalSeconds)
    if ($lcExit -ne 0) { $failed += "luacheck ($lcExit)" }

    Write-Host '==> busted' -ForegroundColor Cyan
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & (Join-Path $LuaBin 'busted.bat')
    $bExit = $LASTEXITCODE
    Write-Host ("busted exit {0} in {1:N1}s" -f $bExit, $sw.Elapsed.TotalSeconds)
    if ($bExit -ne 0) { $failed += "busted ($bExit)" }
} finally {
    Pop-Location
}

if ($failed.Count -gt 0) {
    Write-Host "FAILED: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host 'All Lua checks passed.' -ForegroundColor Green
exit 0
