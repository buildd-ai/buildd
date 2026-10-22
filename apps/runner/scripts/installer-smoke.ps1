# Run the REAL Windows one-line installer the way the docs say
# (`irm .../install.ps1 | iex`), from the commit under test, then drive the
# generated buildd.cmd launcher through the commands that broke on a real
# Windows machine: --version, help, status, init with no workspace id.
#
#   $env:BUILDD_REF = '<branch|sha>'; powershell -ExecutionPolicy ByPass -File apps/runner/scripts/installer-smoke.ps1
#
# Used by .github/workflows/installer-smoke.yml on windows-latest. NOT sandboxed
# like installer-smoke.sh: it installs into your real %USERPROFILE%\.buildd and
# adds %USERPROFILE%\.local\bin to your user PATH, so run it on a throwaway
# machine only.
#
# Fails if: the installer throws, buildd.cmd is missing, `buildd --version` or
# `buildd help` exits non-zero or starts the runner, `buildd status` does not
# say "Status: not logged in", or `buildd init` with no id does not exit 1.

$ErrorActionPreference = "Stop"

$Ref = if ($env:BUILDD_REF) { $env:BUILDD_REF } else { "dev" }
$Repo = if ($env:BUILDD_REPO) { $env:BUILDD_REPO } else { "buildd-ai/buildd" }
Write-Host "smoke: USERPROFILE=$env:USERPROFILE ref=$Ref repo=$Repo"

# Nothing from the caller's environment may point the runner elsewhere.
foreach ($v in 'BUILDD_HOME', 'BUILDD_CONFIG', 'BUILDD_SERVER', 'BUILDD_API_KEY', 'BUILDD_BRANCH', 'PORT', 'PROJECTS_ROOT') {
    Remove-Item "Env:$v" -ErrorAction SilentlyContinue
}

# The installer itself comes from the ref under test, piped exactly like the docs say.
# BUILDD_SERVICE=0: never register the Scheduled Task, never prompt.
$env:BUILDD_REF = $Ref
$env:BUILDD_REPO = $Repo
$env:BUILDD_SERVICE = '0'
irm "https://raw.githubusercontent.com/$Repo/$Ref/apps/runner/install.ps1" | iex
# install.ps1 sets Stop for this session too; the checks below read exit codes.
$ErrorActionPreference = "Continue"

$Buildd = "$env:USERPROFILE\.local\bin\buildd.cmd"
if (-not (Test-Path $Buildd)) { Write-Host "smoke: FAIL - launcher $Buildd was not written"; exit 1 }

# Run buildd.cmd with a deadline: a runner that started never exits on its own.
# Returns @{ Code; Out }, with Code 124 if it had to be killed.
function Invoke-Bounded([string]$Arguments, [string]$Cwd, [int]$Seconds = 60) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $env:ComSpec
    $psi.Arguments = "/d /c `"`"$Buildd`" $Arguments`""
    $psi.WorkingDirectory = $Cwd
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $stdout = $p.StandardOutput.ReadToEndAsync()
    $stderr = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($Seconds * 1000)) {
        & taskkill /T /F /PID $p.Id | Out-Null
        return @{ Code = 124; Out = $stdout.Result + $stderr.Result }
    }
    $p.WaitForExit()
    return @{ Code = $p.ExitCode; Out = $stdout.Result + $stderr.Result }
}

$Failed = $false
function Check([string]$Name, [bool]$Ok, $Result) {
    Write-Host "----- buildd $Name (exit $($Result.Code))"
    Write-Host $Result.Out
    if ($Ok) { Write-Host "smoke: ok - $Name" } else { Write-Host "smoke: FAIL - $Name"; $script:Failed = $true }
}

# From a cwd with no bunfig.toml: the launcher must not depend on where it is run.
# A git repo, so `buildd init` reaches its own usage check rather than "not in a git repository".
$ProjectDir = Join-Path ([System.IO.Path]::GetTempPath()) ("buildd-smoke-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $ProjectDir | Out-Null
& git init -q $ProjectDir

$r = Invoke-Bounded '--version' $ProjectDir
Check '--version' ($r.Code -eq 0 -and $r.Out.Trim().Length -gt 0) $r

$r = Invoke-Bounded 'help' $ProjectDir
Check 'help' ($r.Code -eq 0 -and $r.Out -match 'Usage') $r

$r = Invoke-Bounded 'status' $ProjectDir
Check 'status' ($r.Code -eq 0 -and $r.Out -match 'Status: not logged in') $r

$r = Invoke-Bounded 'init' $ProjectDir
Check 'init (no workspace id)' ($r.Code -eq 1 -and $r.Out -match 'Usage: buildd init') $r

if ($Failed) { Write-Host "smoke: FAILED"; exit 1 }
Write-Host "smoke: PASS"
exit 0
