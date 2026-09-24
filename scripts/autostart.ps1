# Makes sure DM Pilot is running, the Instagram window is open, and automatic sending is on.
# Safe to run any time: if everything is already running it changes nothing.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$api = 'http://127.0.0.1:4777/api'
$logFile = Join-Path $root 'data\autostart.log'

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
  Add-Content -Path $logFile -Value $line -Encoding utf8
  Write-Output $line
}

function Get-State {
  try { Invoke-RestMethod "$api/state" -TimeoutSec 5 } catch { $null }
}

try {
  # 1. DM Pilot itself
  $state = Get-State
  if (-not $state) {
    Log 'DM Pilot not running - starting it'
    Start-Process -FilePath (Join-Path $root 'Start DM Pilot.bat') -WorkingDirectory $root
    for ($i = 0; $i -lt 30 -and -not $state; $i++) { Start-Sleep 2; $state = Get-State }
    if (-not $state) { throw 'DM Pilot did not start within 60 seconds' }
  }

  # 2. Instagram window
  if (-not $state.browser.open) {
    Log 'Opening the Instagram window'
    Invoke-RestMethod -Method Post "$api/browser/open" -ContentType 'application/json' -Body '{}' -TimeoutSec 120 | Out-Null
    Start-Sleep 5
    $state = Get-State
  }
  if (-not $state.browser.loggedIn) { throw 'Instagram is not logged in - log in in the DM Pilot Chrome window' }

  # 3. Automatic sending
  if ($state.runner.running) {
    Log "Automatic sending already running ($($state.runner.phase)) - nothing to do"
  } else {
    Invoke-RestMethod -Method Post "$api/run/start" -ContentType 'application/json' -Body '{"mode":"auto"}' -TimeoutSec 30 | Out-Null
    Log "Started automatic sending ($($state.counts.ready) DMs ready)"
  }
} catch {
  Log "FAILED: $($_.Exception.Message)"
  exit 1
}
