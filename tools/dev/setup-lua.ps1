<#
.SYNOPSIS
  Provision a project-local Lua 5.1 toolchain into .tools\ (git-ignored).

.DESCRIPTION
  Idempotent and self-repairing: every step checks whether its result exists
  and works, and redoes the step if not. Nothing is installed system-wide, no
  admin rights are used, and PATH is changed only for this process.

  What it provisions (all under <repo>\.tools\):
    w64devkit-2.11.0\  portable MinGW-w64 GCC (official GitHub release,
                       SHA-256 pinned below), needed to compile Lua and the
                       C parts of LuaRocks modules (lfs, luasystem, term, lanes).
    venv\              Python venv holding hererocks (wheel hash pinned).
    lua51\             PUC-Rio Lua 5.1.5 (+ the official lua.org bug patch),
                       LuaRocks 3.8.0, luacheck, busted, lanes. hererocks
                       verifies the SHA-256 of the Lua and LuaRocks downloads.
    actionlint-1.7.12\ GitHub Actions workflow linter (SHA-256 pinned).
    luarocks-config.lua  LuaRocks overrides: no per-user tree in %APPDATA%,
                       cache and temp inside .tools, TLS certificates checked.

  Usage (from the repo root):
    powershell -ExecutionPolicy Bypass -File tools\dev\setup-lua.ps1
  Start over:  delete .tools\ and run it again.
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# ---- pinned versions and checksums -----------------------------------------
$W64Version   = '2.11.0'
$W64Url       = "https://github.com/skeeto/w64devkit/releases/download/v$W64Version/w64devkit-x64-$W64Version.7z.exe"
# Published as the release asset digest on GitHub (sha256).
$W64Sha256    = '54c2bb9962e8a30c8270e34c5efc3d5fee579f53087fa7d435b95fbba2af7b2b'
# Hash of hererocks-0.25.1-py3-none-any.whl as published on PyPI.
$HerePin      = 'hererocks==0.25.1 --hash=sha256:43d5e9283588f83aeb703d6d9bc74249d2fa75126638699ca5fdfd1782f47909'
$LuaVersion   = '5.1.5'
# hererocks 0.25.1 knows checksums only up to LuaRocks 3.8.0.
$RocksVersion = '3.8.0'
# Keep luacheck/busted in step with .github/workflows/ci.yml.
$Rocks        = @(
    @{ Name = 'luacheck'; Version = '1.2.0-1' },
    @{ Name = 'busted';   Version = '2.2.0-1' },
    # Optional: lets luacheck check files in parallel (-j); halves a full run.
    @{ Name = 'lanes';    Version = '3.17.2-0' }
)
# SHA-256 from the release's actionlint_<ver>_checksums.txt.
$AlVersion    = '1.7.12'
$AlUrl        = "https://github.com/rhysd/actionlint/releases/download/v$AlVersion/actionlint_${AlVersion}_windows_amd64.zip"
$AlSha256     = '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9'

# ---- paths ------------------------------------------------------------------
$Root   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Tools  = Join-Path $Root '.tools'
$Dl     = Join-Path $Tools 'downloads'
$W64Dir = Join-Path $Tools "w64devkit-$W64Version"
$W64Bin = Join-Path $W64Dir 'w64devkit\bin'
$Venv   = Join-Path $Tools 'venv'
$VenvPy = Join-Path $Venv 'Scripts\python.exe'
$LuaDir = Join-Path $Tools 'lua51'
$LuaExe = Join-Path $LuaDir 'bin\lua.exe'
$LrDir  = Join-Path $LuaDir 'luarocks'
$LrLua  = Join-Path $LrDir 'luarocks.lua'
$LrCfg  = Join-Path $Tools 'luarocks-config.lua'
$LrTmp  = Join-Path $Tools 'tmp'
$AlDir  = Join-Path $Tools "actionlint-$AlVersion"
# Windows' own tar.exe is bsdtar (libarchive): it can read the 7-Zip
# self-extracting archive without executing it. Git Bash's GNU tar cannot.
$BsdTar = Join-Path $env:SystemRoot 'System32\tar.exe'
$Curl   = Join-Path $env:SystemRoot 'System32\curl.exe'

function Step($msg) { Write-Host ("==> [{0:HH:mm:ss}] {1}" -f (Get-Date), $msg) -ForegroundColor Cyan }

function Invoke-Native {
    # Run a native command; throw on non-zero exit. Native stderr must not
    # become a terminating error under ErrorActionPreference=Stop (Windows
    # PowerShell 5.1 wraps it), hence the local 'Continue'.
    param([string]$Exe, [string[]]$Arguments)
    $ErrorActionPreference = 'Continue'
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe exited with $LASTEXITCODE" }
}

function Test-Native {
    # Run a native command quietly; return $true if it exits 0.
    param([string]$Exe, [string[]]$Arguments)
    if (-not (Test-Path $Exe)) { return $false }
    $ErrorActionPreference = 'Continue'
    & $Exe @Arguments *> $null
    return ($LASTEXITCODE -eq 0)
}

function Get-VerifiedArchive {
    # Download $Url into downloads\ (once) and check its SHA-256.
    param([string]$Url, [string]$Sha256)
    $archive = Join-Path $Dl (Split-Path $Url -Leaf)
    if (-not (Test-Path $archive)) {
        Invoke-Native $Curl @('-fsSL', '--proto', '=https', '-o', $archive, $Url)
    }
    $hash = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
    if ($hash -ne $Sha256) {
        Remove-Item -Force $archive
        throw "checksum mismatch for $Url`n  got      $hash`n  expected $Sha256"
    }
    return $archive
}

function Expand-Fresh {
    # Untrusted archive: unpack into its own fresh, empty directory.
    param([string]$Archive, [string]$Dest)
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    New-Item -ItemType Directory $Dest | Out-Null
    Invoke-Native $BsdTar @('-xf', $Archive, '-C', $Dest)
}

New-Item -ItemType Directory -Force $Tools, $Dl, $LrTmp | Out-Null

# ---- 1. w64devkit (GCC) -----------------------------------------------------
if (-not (Test-Native (Join-Path $W64Bin 'gcc.exe') @('--version'))) {
    Step "w64devkit $W64Version"
    Expand-Fresh (Get-VerifiedArchive $W64Url $W64Sha256) $W64Dir
} else { Step "w64devkit $W64Version present" }

# PATH for this process only: GCC must be found by hererocks and LuaRocks.
$env:PATH = "$LuaDir\bin;$LrDir;$W64Bin;$env:PATH"

# ---- 2. hererocks in a venv -------------------------------------------------
# Run as 'python -m hererocks': no pip-generated launcher .exe involved.
if (-not (Test-Native $VenvPy @('-I', '-c', 'import hererocks'))) {
    Step 'Python venv + hererocks'
    if (-not (Test-Native $VenvPy @('--version'))) {
        if (Test-Path $Venv) { Remove-Item -Recurse -Force $Venv }
        Invoke-Native 'python' @('-m', 'venv', $Venv)
    }
    $req = Join-Path $Tools 'hererocks-requirements.txt'
    Set-Content -Encoding ascii -Path $req -Value $HerePin
    Invoke-Native $VenvPy @('-I', '-m', 'pip', 'install', '-q', '--disable-pip-version-check',
                            '--force-reinstall', '--require-hashes', '--no-deps', '-r', $req)
} else { Step 'hererocks present' }

# ---- 3. Lua 5.1.5 + LuaRocks via hererocks ----------------------------------
# LuaRocks is always run through lua.exe directly, never luarocks.bat: the
# .bat retries with UAC elevation when LuaRocks exits with code 2.
$env:LUAROCKS_CONFIG = $LrCfg
$env:LUA_PATH = "$LrDir\lua\?.lua;$LrDir\lua\?\init.lua;;"
$env:LUA_CPATH = ';;'
# LuaRocks unpacks rocks in %TEMP%; keep that inside .tools as well.
$env:TEMP = $LrTmp
$env:TMP = $LrTmp

function Test-LuaHealthy {
    # PUC-Rio 5.1 (not LuaJIT, which also reports _VERSION "Lua 5.1") and a
    # LuaRocks that starts.
    if (-not (Test-Path $LuaExe)) { return $false }
    $ErrorActionPreference = 'Continue'
    $v = & $LuaExe -e 'io.write(_VERSION, jit and [[ (LuaJIT)]] or [[]])' 2>$null
    if ($v -ne 'Lua 5.1') { return $false }
    return (Test-Native $LuaExe @($LrLua, '--version'))
}

function Install-Lua {
    Step "Lua $LuaVersion + LuaRocks $RocksVersion (hererocks, target mingw)"
    if (Test-Path $LuaDir) { Remove-Item -Recurse -Force $LuaDir }
    # hererocks runs LuaRocks' install.bat by bare name from its build dir.
    # NoDefaultCurrentDirectoryInExePath (set by some shells) blocks that, so
    # clear it for the duration of this one call only.
    $saved = $env:NoDefaultCurrentDirectoryInExePath
    Remove-Item Env:NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue
    try {
        Invoke-Native $VenvPy @('-I', '-m', 'hererocks',
            $LuaDir, '-l', $LuaVersion, '--patch', '-r', $RocksVersion,
            '--target', 'mingw',
            '--downloads', (Join-Path $Dl 'hererocks'),
            '--builds', (Join-Path $Tools 'build-cache'))
    } finally {
        if ($null -ne $saved) { $env:NoDefaultCurrentDirectoryInExePath = $saved }
    }
}

# ---- 4. LuaRocks overrides (regenerated every run) --------------------------
function Write-LuaRocksConfig {
    $fwd = { param($p) $p -replace '\\', '/' }
    $cfg = @"
-- Generated by tools/dev/setup-lua.ps1. Do not edit; re-run the script.
-- Keep everything inside .tools: no per-user rocks tree in %APPDATA%.
rocks_trees = { { name = "system", root = [[$(& $fwd $LuaDir)]] } }
local_cache = [[$(& $fwd (Join-Path $Tools 'luarocks-cache'))]]
rocks_servers = { "https://luarocks.org" }
-- The bundled wget is old and hererocks turns certificate checks off.
-- Use Windows' curl (Schannel) and verify certificates.
check_certificates = true
downloader = "curl"
variables = {
  CURL = [[$(& $fwd $Curl)]],
  -- Bare "gcc", resolved through this process's PATH (w64devkit first).
  -- LuaRocks pastes CC/LD unquoted into the command line, so a full path
  -- containing spaces (like this repo's) breaks the build. Plain gcc also
  -- avoids the default ccache-gcc, which writes a cache to the user profile.
  CC = "gcc",
  LD = "gcc",
}
"@
    Set-Content -Encoding ascii -Path $LrCfg -Value $cfg
}

# ---- 5. luacheck, busted, lanes ---------------------------------------------
function Install-Rocks {
    foreach ($r in $Rocks) {
        # 'luarocks list --porcelain' prints "name<TAB>version<TAB>status<TAB>tree".
        $ErrorActionPreference = 'Continue'
        $have = & $LuaExe $LrLua list --porcelain $r.Name 2>$null | Out-String
        $ErrorActionPreference = 'Stop'
        if ($have -match ("(?m)^" + [regex]::Escape($r.Name) + "`t" + [regex]::Escape($r.Version) + "`t")) {
            Step "$($r.Name) $($r.Version) present"
        } else {
            Step "luarocks install $($r.Name) $($r.Version)"
            Invoke-Native $LuaExe @($LrLua, 'install', $r.Name, $r.Version)
        }
    }
}

function Test-RocksHealthy {
    (Test-Native (Join-Path $LuaDir 'bin\luacheck.bat') @('--version')) -and
    (Test-Native (Join-Path $LuaDir 'bin\busted.bat') @('--version')) -and
    (Test-Native $LuaExe @('-e', 'require([[lanes]])'))
}

# Two attempts: if anything in lua51\ is broken (e.g. files removed by
# antivirus, see README note in the report), rebuild it from scratch once.
Write-LuaRocksConfig
for ($attempt = 1; $attempt -le 2; $attempt++) {
    if (-not (Test-LuaHealthy)) { Install-Lua }
    else { Step "Lua $LuaVersion + LuaRocks present" }
    if (-not (Test-LuaHealthy)) { throw "Lua/LuaRocks unusable after install (attempt $attempt)" }
    Install-Rocks
    if (Test-RocksHealthy) { break }
    if ($attempt -eq 2) {
        throw 'luacheck/busted do not run after a clean rebuild. Files in .tools\ may be removed by antivirus; check its quarantine.'
    }
    Write-Warning 'Installed tools do not run; rebuilding .tools\lua51 from scratch.'
    Remove-Item -Recurse -Force $LuaDir
}

# ---- 6. actionlint ------------------------------------------------------------
if (-not (Test-Native (Join-Path $AlDir 'actionlint.exe') @('-version'))) {
    Step "actionlint $AlVersion"
    Expand-Fresh (Get-VerifiedArchive $AlUrl $AlSha256) $AlDir
} else { Step "actionlint $AlVersion present" }

# ---- 7. versions --------------------------------------------------------------
Step 'Versions'
$v = & $LuaExe -e 'io.write(_VERSION)'
Write-Host "lua: $v (PUC-Rio $LuaVersion + bug patch, built by hererocks)"
Invoke-Native (Join-Path $LuaDir 'bin\luacheck.bat') @('--version')
Invoke-Native (Join-Path $LuaDir 'bin\busted.bat') @('--version')
Invoke-Native (Join-Path $AlDir 'actionlint.exe') @('-version')
Step 'Toolchain ready'
