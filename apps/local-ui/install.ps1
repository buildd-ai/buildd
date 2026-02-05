# buildd local-ui installer for Windows
# Usage: irm buildd.dev/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host "Installing buildd local-ui..." -ForegroundColor Green

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
apps/local-ui/
packages/shared/
package.json
"@ | Set-Content ".git\info\sparse-checkout"

    git fetch origin dev
    git read-tree -mu HEAD
    git reset --hard origin/dev
    Pop-Location
} else {
    Write-Host "Cloning buildd (local-ui only)..."

    if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Push-Location $InstallDir
    git init
    git remote add origin https://github.com/buildd-ai/buildd.git
    git config core.sparseCheckout true

    @"
apps/local-ui/
packages/shared/
package.json
"@ | Set-Content ".git\info\sparse-checkout"

    git fetch --depth 1 origin dev
    git checkout dev
    Pop-Location
}

# Install dependencies
Push-Location "$InstallDir\apps\local-ui"
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

bun run "%USERPROFILE%\.buildd\apps\local-ui\src\index.ts" %*
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
Write-Host "Run buildd to start:"
Write-Host "  buildd"
Write-Host ""
Write-Host "Then open http://localhost:8766 to connect your account."
Write-Host ""
Write-Host "Restart your terminal to use the 'buildd' command" -ForegroundColor Yellow
