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
    irm bun.sh/install.ps1 | iex
    $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
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
package.json
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
package.json
"@ | Set-Content ".git\info\sparse-checkout"

    git fetch --depth 1 origin dev
    git checkout dev
    Pop-Location
}

# Install dependencies
Push-Location "$InstallDir\apps\runner"
bun install
Pop-Location

# Create bin directory and launcher
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

@'
@echo off
setlocal

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

REM `buildd login` connects this machine to an account, as in the bash launcher.
if /i "%~1"=="login" (
    bun run "%USERPROFILE%\.buildd\apps\runner\src\login.ts" %2 %3
    exit /b
)

REM Restart loop (exit code 75 = update applied, restart) — mirrors install.sh's
REM bash launcher so the self-updater behaves the same on every platform.
:runloop
bun run "%USERPROFILE%\.buildd\apps\runner\src\index.ts" %*
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
# restarts if it crashes, so it survives closing the terminal and reboots —
# see apps/runner/README.md "Running as a service". -Service registers
# non-interactively; otherwise ask when there's an interactive session.
$TaskName = "buildd runner"
$InstallService = $false
if ($Service) {
    $InstallService = $true
} elseif ([Environment]::UserInteractive) {
    $Answer = Read-Host "Run buildd in the background so it survives closing this terminal and reboots? [Y/n]"
    $InstallService = -not ($Answer -match '^[nN]')
}

if ($InstallService) {
    try {
        $Action = New-ScheduledTaskAction -Execute "$BinDir\buildd.cmd"
        $Trigger = New-ScheduledTaskTrigger -AtLogOn
        $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
        $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "Registered Scheduled Task '$TaskName' (runs at logon, as your user, restarts on crash)." -ForegroundColor Green
        Write-Host "Manage it with: Get-ScheduledTask -TaskName '$TaskName' | Unregister-ScheduledTask -Confirm:`$false"
    } catch {
        Write-Host "Could not register the Scheduled Task ($($_.Exception.Message)) — run buildd manually, or retry from an elevated PowerShell." -ForegroundColor Yellow
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
    Write-Host "  then restart the 'buildd runner' Scheduled Task so it picks up your account"
}
