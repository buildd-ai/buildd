<#
Credential-free real-host enforcement harness. Run from the repository root:
  powershell -NoProfile -File apps/runner/scripts/verify-windows-sandbox.ps1
Only disposable targets under the checkout are used. Does not run elevated setup,
create accounts, or change firewall policy. Codex may ACL its disposable roots.
Network controls test a TCP connection, not a shell command's availability. The
same endpoint must succeed with network enabled before AND after a denied test.
Passing these controls does not qualify buildd's open-network worker for protected work.
#>
param([ValidatePattern('^[a-zA-Z0-9.-]+$')][string]$NetworkHost = 'developers.openai.com',
      [ValidateRange(1,65535)][int]$NetworkPort = 443)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Native Windows required' }
$checkout = (Get-Location).Path
$root = Join-Path $checkout ('.windows-sandbox-probe-' + [Guid]::NewGuid().ToString('N'))
$workspace = Join-Path $root 'workspace'
$outside = Join-Path $root 'outside'
$homeDir = Join-Path $root 'home'
$priorHome = $env:CODEX_HOME
$binary = (& bun -e "import {resolveCodexBinary} from './apps/runner/src/codex-windows-sandbox'; const p=resolveCodexBinary(); if(!p)process.exit(1); console.log(p)").Trim()
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $binary)) { throw 'SDK executable unavailable' }

function Run-Control($implementation, $mode, $network, $command) {
  $permissionProfile = if ($mode -eq 'read-only') { ':read-only' } else { ':workspace' }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $lines = & $binary sandbox --include-managed-config --permission-profile $permissionProfile -c "windows.sandbox=`"$implementation`"" `
    -c 'features.prefer_mxc=false' -c "sandbox_mode=`"$mode`"" `
    -c "sandbox_workspace_write.network_access=$network" `
    -c 'sandbox_workspace_write.exclude_tmpdir_env_var=true' `
    -c 'sandbox_workspace_write.exclude_slash_tmp=true' -- cmd.exe /d /c $command 2>&1
  $exit = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  [pscustomobject]@{ exit = $exit; output = ($lines -join "`n") }
}

try {
  New-Item -ItemType Directory -Path $workspace,$outside,$homeDir | Out-Null
  $env:CODEX_HOME = $homeDir
  & $binary --version
  Write-Output ([Environment]::OSVersion.VersionString)
  Write-Output "SDK executable: $binary"
  Set-Location -LiteralPath $workspace
  # An absolute system executable, so missing PATH commands cannot count as a denial.
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $connect = "`$c = New-Object Net.Sockets.TcpClient; try { `$t = `$c.ConnectAsync('$NetworkHost',$NetworkPort); if (!`$t.Wait(5000)) { throw 'timeout' }; if (!`$c.Connected) { throw 'not connected' }; 'CONNECTED' } catch { 'BLOCKED' } finally { `$c.Dispose() }"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($connect))
  $networkCommand = "`"$ps`" -NoProfile -NonInteractive -EncodedCommand $encoded"
  foreach ($implementation in @('mxc','unelevated')) {
    foreach ($mode in @('read-only','workspace-write')) {
      $insidePath = Join-Path $workspace 'inside.txt'
      $escapedPath = Join-Path $outside 'escaped.txt'
      # Host controls prove both targets exist and are writable before sandboxing.
      Set-Content -LiteralPath $insidePath -Value 'host-control'
      Set-Content -LiteralPath $escapedPath -Value 'host-control'
      Remove-Item -LiteralPath $insidePath,$escapedPath
      $inside = Run-Control $implementation $mode 'true' '(echo ok> inside.txt) 2>nul & echo BUILDD_SANDBOX_CONTROL_OK'
      $escaped = Run-Control $implementation $mode 'true' '(echo x> ..\outside\escaped.txt) 2>nul & echo BUILDD_SANDBOX_CONTROL_OK'
      $writes = $inside.exit -eq 0 -and $escaped.exit -eq 0 -and `
        $inside.output.Contains('BUILDD_SANDBOX_CONTROL_OK') -and $escaped.output.Contains('BUILDD_SANDBOX_CONTROL_OK') -and `
        ((Test-Path -LiteralPath $insidePath) -eq ($mode -eq 'workspace-write')) -and !(Test-Path -LiteralPath $escapedPath)
      # read-only network semantics vary: observe, never infer from mode alone.
      $before = Run-Control $implementation $mode 'true' $networkCommand
      $denied = Run-Control $implementation $mode 'false' $networkCommand
      $after = Run-Control $implementation $mode 'true' $networkCommand
      $networkVerified = $before.exit -eq 0 -and $after.exit -eq 0 -and $denied.exit -eq 0 -and `
        $before.output.Contains('CONNECTED') -and $after.output.Contains('CONNECTED') -and $denied.output.Contains('BLOCKED')
      [pscustomobject]@{ implementation=$implementation; mode=$mode; writesVerified=$writes;
        offlineNetworkControl=$networkVerified; workerNetworkScope=$false; protectedEligible=$false;
        inside=$inside; outside=$escaped; networkBefore=$before; networkDenied=$denied; networkAfter=$after } | ConvertTo-Json -Depth 4
    }
  }
} finally {
  Set-Location -LiteralPath $checkout
  $env:CODEX_HOME = $priorHome
  $resolvedRoot = [IO.Path]::GetFullPath($root)
  if (!$resolvedRoot.StartsWith($checkout + [IO.Path]::DirectorySeparatorChar) -or
      !(Split-Path -Leaf $resolvedRoot).StartsWith('.windows-sandbox-probe-')) { throw 'Unsafe cleanup path' }
  if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
}
