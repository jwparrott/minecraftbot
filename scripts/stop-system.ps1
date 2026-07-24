param(
  [switch]$StopAnyOllama
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Stop-ByIdIfRunning {
  param(
    [Nullable[int]]$Pid,
    [string]$Label
  )

  if (-not $Pid) {
    return $false
  }

  try {
    $process = Get-Process -Id $Pid -ErrorAction Stop
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
    Write-Host "Stopped $Label (PID: $Pid)."
    return $true
  } catch {
    Write-Host "$Label PID $Pid is not running."
    return $false
  }
}

function Stop-BotByScan {
  param([string]$ProjectRoot)

  $matches = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -and
    (
      $_.CommandLine -match "src[\\/]+index\.ts" -or
      $_.CommandLine -match "dist[\\/]+index\.js"
    ) -and
    $_.CommandLine -match [regex]::Escape($ProjectRoot)
  }

  $stopped = $false
  foreach ($match in $matches) {
    Stop-Process -Id $match.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped bot process by scan (PID: $($match.ProcessId))."
    $stopped = $true
  }
  return $stopped
}

function Stop-ServerByScan {
  param(
    [string]$ServerJar,
    [string]$ServerDirectory
  )

  $jarRegex = if ($ServerJar -and $ServerJar.Trim().Length -gt 0) {
    [regex]::Escape($ServerJar)
  } else {
    "server.*\.jar"
  }
  $dirRegex = if ($ServerDirectory -and $ServerDirectory.Trim().Length -gt 0) {
    [regex]::Escape($ServerDirectory)
  } else {
    ""
  }

  $matches = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "java.exe" -and
    $_.CommandLine -and
    $_.CommandLine -match "-jar" -and
    $_.CommandLine -match $jarRegex -and
    (
      $dirRegex.Length -eq 0 -or $_.CommandLine -match $dirRegex
    )
  }

  $stopped = $false
  foreach ($match in $matches) {
    Stop-Process -Id $match.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped server process by scan (PID: $($match.ProcessId))."
    $stopped = $true
  }
  return $stopped
}

function Stop-OllamaByScan {
  $matches = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "ollama.exe" -and $_.CommandLine -and $_.CommandLine -match "\bserve\b"
  }
  $stopped = $false
  foreach ($match in $matches) {
    Stop-Process -Id $match.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped Ollama serve process by scan (PID: $($match.ProcessId))."
    $stopped = $true
  }
  return $stopped
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
$runtimeDir = Join-Path $projectRoot ".runtime"
$statePath = Join-Path $runtimeDir "process-state.json"

$state = $null
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
}

Write-Step "Stopping bot"
$botStopped = $false
if ($state -and $state.bot -and $state.bot.pid) {
  $botStopped = Stop-ByIdIfRunning -Pid ([int]$state.bot.pid) -Label "bot"
}
if (-not $botStopped) {
  $botStopped = Stop-BotByScan -ProjectRoot $projectRoot
}
if (-not $botStopped) {
  Write-Host "No running bot process found."
}

Write-Step "Stopping Minecraft server"
$serverStopped = $false
if ($state -and $state.server -and $state.server.pid) {
  $serverStopped = Stop-ByIdIfRunning -Pid ([int]$state.server.pid) -Label "server"
}
if (-not $serverStopped) {
  $jar = if ($state -and $state.server -and $state.server.jar) { [string]$state.server.jar } else { "" }
  $dir = if ($state -and $state.server -and $state.server.directory) { [string]$state.server.directory } else { "" }
  $serverStopped = Stop-ServerByScan -ServerJar $jar -ServerDirectory $dir
}
if (-not $serverStopped) {
  Write-Host "No running Minecraft server process found."
}

Write-Step "Stopping Ollama (only if started by setup script)"
$ollamaStopped = $false
if ($state -and $state.ollama -and $state.ollama.startedByScript -and $state.ollama.pid) {
  $ollamaStopped = Stop-ByIdIfRunning -Pid ([int]$state.ollama.pid) -Label "ollama"
}
if (-not $ollamaStopped -and $StopAnyOllama) {
  $ollamaStopped = Stop-OllamaByScan
}
if (-not $ollamaStopped) {
  Write-Host "No tracked Ollama process stopped. Use -StopAnyOllama to force-stop all Ollama serve processes."
}

if (Test-Path -LiteralPath $statePath -PathType Leaf) {
  Remove-Item -LiteralPath $statePath -Force
  Write-Host ""
  Write-Host "Removed runtime state file: $statePath"
}
