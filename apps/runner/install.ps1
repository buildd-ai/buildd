# buildd runner installer for Windows
# Usage: irm buildd.dev/install.ps1 | iex
# With the background service: &([ScriptBlock]::Create((irm buildd.dev/install.ps1))) -Service

param(
    # Register the background Scheduled Task non-interactively (for scripted
    # installs). Without it, an interactive session is asked at the end.
    [switch]$Service
)

$ErrorActionPreference = "Stop"

Write-Host "Installing buildd runner..." -ForegroundColor Green

# Check for bun
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "Bun not found. Installing..." -ForegroundColor Yellow
    # bun's installer rewrites this process's PATH from the registry, which
    # drops entries added only to the session (e.g. git), so restore ours.
    $SavedPath = $env:Path
    irm bun.sh/install.ps1 | iex
    $env:Path = "$env:USERPROFILE\.bun\bin;$SavedPath"
}

$InstallDir = "$env:USERPROFILE\.buildd"
$BinDir = "$env:USERPROFILE\.local\bin"

# Clone or update
if (Test-Path "$InstallDir\.git") {
    Write-Host "Updating existing installation..."
    Push-Location $InstallDir

    # Update sparse checkout config
    @"
apps/runner/
packages/shared/
packages/core/
packages/ai-kit/
packages/dispatch-contract/
packages/spec-contract/
scripts/stub-server-only.ts
bunfig.toml
/package.json
/bun.lock
"@ | Set-Content ".git\info\sparse-checkout"

    git fetch origin dev
    git read-tree -mu HEAD
    git reset --hard origin/dev
    Pop-Location
} else {
    Write-Host "Cloning buildd (runner only)..."

    if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Push-Location $InstallDir
    git init
    git remote add origin https://github.com/buildd-ai/buildd.git
    git config core.sparseCheckout true

    @"
apps/runner/
packages/shared/
packages/core/
packages/ai-kit/
packages/dispatch-contract/
packages/spec-contract/
scripts/stub-server-only.ts
bunfig.toml
/package.json
/bun.lock
"@ | Set-Content ".git\info\sparse-checkout"

    git fetch --depth 1 origin dev
    git checkout dev
    Pop-Location
}

# Install dependencies, exactly as the repo's bun.lock pins them, as install.sh
# does. The root package.json stays the repo's own: a rewritten one drops its
# "overrides", and bun then refuses the lockfile as changed.
Push-Location "$InstallDir\apps\runner"
bun install --frozen-lockfile
Pop-Location

# Create bin directory and launcher
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

@'
@echo off
setlocal EnableDelayedExpansion

REM Every bun run preloads this stub, as in the bash launcher: bun reads
REM bunfig.toml from the cwd only, and buildd runs from anywhere.
set "BUILDD_PRELOAD=%USERPROFILE%\.buildd\scripts\stub-server-only.ts"

REM Auto-detect project roots if not set
if "%PROJECTS_ROOT%"=="" (
    set "ROOTS="
    for %%D in ("%USERPROFILE%\projects" "%USERPROFILE%\dev" "%USERPROFILE%\code" "%USERPROFILE%\src" "%USERPROFILE%\repos" "%USERPROFILE%\work") do (
        if exist "%%~D" (
            if defined ROOTS (set "ROOTS=!ROOTS!,%%~D") else (set "ROOTS=%%~D")
        )
    )
    if not defined ROOTS set "ROOTS=%USERPROFILE%"
    set "PROJECTS_ROOT=!ROOTS!"
)

REM The arguments after the subcommand (%* never shifts, so the runner still gets all of them).
set "SUBCMD=%~1"
set "REST="
:collect
shift
if "%~1"=="" goto collected
set "REST=!REST! %1"
goto collect
:collected

REM `buildd login` connects this machine to an account, as in the bash launcher.
if /i "%SUBCMD%"=="login" (
    bun --no-env-file run --preload "%BUILDD_PRELOAD%" "%USERPROFILE%\.buildd\apps\runner\src\login.ts" !REST!
    exit /b !ERRORLEVEL!
)

REM `buildd status`, `buildd logout` and `buildd init <workspace-id>` run the same
REM launcher-commands.ts the bash launcher does; the runner rejects them.
if /i "%SUBCMD%"=="status" (
    bun --no-env-file run --preload "%BUILDD_PRELOAD%" "%USERPROFILE%\.buildd\apps\runner\src\launcher-commands.ts" status !REST!
    exit /b !ERRORLEVEL!
)
if /i "%SUBCMD%"=="logout" (
    bun --no-env-file run --preload "%BUILDD_PRELOAD%" "%USERPROFILE%\.buildd\apps\runner\src\launcher-commands.ts" logout !REST!
    exit /b !ERRORLEVEL!
)
if /i "%SUBCMD%"=="init" (
    bun --no-env-file run --preload "%BUILDD_PRELOAD%" "%USERPROFILE%\.buildd\apps\runner\src\launcher-commands.ts" init !REST!
    exit /b !ERRORLEVEL!
)

REM `buildd install` puts the agent plugin hooks into Claude Code, Codex and Cursor.
if /i "%SUBCMD%"=="install" (
    bun --no-env-file run --preload "%BUILDD_PRELOAD%" "%USERPROFILE%\.buildd\apps\runner\src\agent-plugin-install.ts" !REST!
    exit /b !ERRORLEVEL!
)

REM `buildd service install|uninstall|status|logs` manages the background Scheduled Task.
if /i "%SUBCMD%"=="service" (
    bun --no-env-file run --preload "%BUILDD_PRELOAD%" "%USERPROFILE%\.buildd\apps\runner\src\service.ts" !REST!
    exit /b !ERRORLEVEL!
)

REM Restart loop (exit code 75 = update applied, restart) - mirrors install.sh's
REM bash launcher so the self-updater behaves the same on every platform.
:runloop
bun --no-env-file run --preload "%BUILDD_PRELOAD%" "%USERPROFILE%\.buildd\apps\runner\src\index.ts" %*
if %ERRORLEVEL% EQU 75 (
    echo Restarting after update...
    timeout /t 1 /nobreak >nul
    goto runloop
)
exit /b %ERRORLEVEL%
'@ | Set-Content "$BinDir\buildd.cmd"

# Add to PATH if needed
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$UserPath", "User")
    Write-Host "Added $BinDir to PATH" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host ""

# Offer to register buildd as a Scheduled Task that starts at logon and
# restarts if it crashes, so it survives closing the terminal and reboots -
# see apps/runner/README.md "Running as a service". -Service registers
# non-interactively; otherwise ask when there's an interactive session.
# `buildd service install` (apps/runner/src/service.ts) owns the task itself.
$InstallService = $false
if ($Service) {
    $InstallService = $true
} elseif ([Environment]::UserInteractive) {
    $Answer = Read-Host "Run buildd in the background so it survives closing this terminal and reboots? [Y/n]"
    $InstallService = -not ($Answer -match '^[nN]')
}

if ($InstallService) {
    $env:BUILDD_INSTALLER = '1'
    & "$BinDir\buildd.cmd" service install
    $ServiceExit = $LASTEXITCODE
    Remove-Item Env:BUILDD_INSTALLER
    if ($ServiceExit -ne 0) {
        Write-Host "Could not install the background service - run 'buildd service install' to retry, or 'buildd' to run it in the foreground." -ForegroundColor Yellow
    }
} else {
    Write-Host "Tip: re-run this installer with -Service to run it in the background." -ForegroundColor Yellow
}

# The runner is headless unless started with --debug: nothing listens on
# localhost:8766, so the next step is `buildd login` unless a login exists.
$ConfigFile = "$env:USERPROFILE\.buildd\config.json"
$LoggedIn = [bool]$env:BUILDD_API_KEY
if (-not $LoggedIn -and (Test-Path $ConfigFile)) {
    try { $LoggedIn = [bool]((Get-Content $ConfigFile -Raw | ConvertFrom-Json).apiKey) } catch { $LoggedIn = $false }
}

Write-Host ""
if ($LoggedIn) {
    Write-Host "Already logged in, so skip 'buildd login'." -ForegroundColor Green
}
Write-Host "Next:"
Write-Host "  restart your terminal    so buildd is on your PATH"
if (-not $LoggedIn) {
    Write-Host "  buildd login             connect this machine to your buildd account"
    Write-Host "                           (no browser on this machine? buildd login --device)"
}
if (-not $InstallService) {
    Write-Host "  buildd                   start the runner in this terminal"
} elseif (-not $LoggedIn) {
    Write-Host "  buildd service install   restart the background service with your account"
}
