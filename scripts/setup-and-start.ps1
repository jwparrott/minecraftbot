param(
  [string]$ServerDir = "",
  [string]$Model = "gemma2:2b",
  [string]$BotUsername = "AdminNPC",
  [string]$AdminPlayers = "",
  [switch]$SkipServerStart
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Save-State {
  param(
    [string]$StatePath,
    [hashtable]$State
  )
  $json = $State | ConvertTo-Json -Depth 5
  Set-Content -LiteralPath $StatePath -Value $json -Encoding UTF8
}

function Test-CommandAvailable {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WithWinget {
  param(
    [string]$PackageId,
    [string]$FriendlyName,
    [string]$CommandName
  )

  if (Test-CommandAvailable $CommandName) {
    Write-Host "$FriendlyName already installed."
    return
  }
  if (-not (Test-CommandAvailable "winget")) {
    throw "winget is required to install $FriendlyName automatically. Install it and re-run."
  }

  Write-Step "Installing $FriendlyName with winget"
  winget install --id $PackageId -e --accept-source-agreements --accept-package-agreements
  if (-not (Test-CommandAvailable $CommandName)) {
    throw "$FriendlyName was installed but '$CommandName' is not available in this shell. Open a new terminal and re-run."
  }
}

function Set-OrAppendEnvLine {
  param(
    [string]$Path,
    [string]$Key,
    [string]$Value
  )

  $escapedKey = [regex]::Escape($Key)
  $content = if (Test-Path -LiteralPath $Path) {
    Get-Content -LiteralPath $Path -Raw
  } else {
    ""
  }

  if ($content -match "(?m)^$escapedKey=") {
    $content = [regex]::Replace($content, "(?m)^$escapedKey=.*$", "$Key=$Value")
  } else {
    if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) {
      $content += "`r`n"
    }
    $content += "$Key=$Value`r`n"
  }

  Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
}

function Resolve-ServerDirectory {
  param([string]$ProjectRoot, [string]$RequestedServerDir)

  if ($RequestedServerDir -and $RequestedServerDir.Trim().Length -gt 0) {
    $full = [System.IO.Path]::GetFullPath($RequestedServerDir)
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
      throw "Specified server directory does not exist: $full"
    }
    return $full
  }

  $candidates = @(
    (Join-Path $ProjectRoot "server"),
    (Join-Path $ProjectRoot "minecraft-server"),
    (Join-Path $ProjectRoot "minecraft_server"),
    (Join-Path $ProjectRoot "mc-server")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Container) {
      return $candidate
    }
  }

  throw "No server directory found. Re-run with -ServerDir <path-to-server-folder>."
}

function Get-ServerPort {
  param([string]$ResolvedServerDir)
  $defaultPort = 25565
  $propertiesPath = Join-Path $ResolvedServerDir "server.properties"
  if (-not (Test-Path -LiteralPath $propertiesPath -PathType Leaf)) {
    return $defaultPort
  }

  $lines = Get-Content -LiteralPath $propertiesPath
  foreach ($line in $lines) {
    if ($line -match "^\s*server-port=(\d+)\s*$") {
      return [int]$Matches[1]
    }
  }
  return $defaultPort
}

function Find-ServerJar {
  param([string]$ResolvedServerDir)
  $jars = Get-ChildItem -LiteralPath $ResolvedServerDir -File -Filter "*.jar" | Sort-Object LastWriteTime -Descending
  if (-not $jars -or $jars.Count -eq 0) {
    throw "No .jar file found in server directory: $ResolvedServerDir"
  }

  $priority = $jars | Where-Object {
    $_.Name -match "(paper|purpur|spigot|craftbukkit|fabric|forge|server)"
  } | Select-Object -First 1

  if ($priority) {
    return $priority
  }
  return $jars[0]
}

function Ensure-OllamaReady {
  param([string]$ModelName)

  Write-Step "Ensuring Ollama service is running"
  $ready = $false
  try {
    Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 | Out-Null
    $ready = $true
  } catch {
    $ready = $false
  }

  $startedByScript = $false
  $ollamaProcessId = $null
  if (-not $ready) {
    $ollamaProcess = Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden -PassThru
    $startedByScript = $true
    $ollamaProcessId = $ollamaProcess.Id
    for ($i = 0; $i -lt 30; $i += 1) {
      Start-Sleep -Seconds 1
      try {
        Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 | Out-Null
        $ready = $true
        break
      } catch {
      }
    }
  }

  if (-not $ready) {
    throw "Ollama API did not become ready on http://127.0.0.1:11434."
  }

  Write-Step "Pulling model '$ModelName'"
  & ollama pull $ModelName
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to pull model: $ModelName"
  }

  return @{
    startedByScript = $startedByScript
    pid = $ollamaProcessId
  }
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
$envPath = Join-Path $projectRoot ".env"
$envExamplePath = Join-Path $projectRoot ".env.example"
$runtimeDir = Join-Path $projectRoot ".runtime"
$statePath = Join-Path $runtimeDir "process-state.json"

if (-not (Test-Path -LiteralPath $runtimeDir -PathType Container)) {
  New-Item -ItemType Directory -Path $runtimeDir | Out-Null
}

Write-Step "Installing prerequisites (Node.js, Java, Ollama)"
Install-WithWinget -PackageId "OpenJS.NodeJS.LTS" -FriendlyName "Node.js LTS" -CommandName "node"
Install-WithWinget -PackageId "EclipseAdoptium.Temurin.21.JRE" -FriendlyName "Java 21 JRE" -CommandName "java"
Install-WithWinget -PackageId "Ollama.Ollama" -FriendlyName "Ollama" -CommandName "ollama"

$ollamaState = Ensure-OllamaReady -ModelName $Model

if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
  Write-Step "Creating .env from .env.example"
  Copy-Item -LiteralPath $envExamplePath -Destination $envPath -Force
}

$resolvedServerDir = Resolve-ServerDirectory -ProjectRoot $projectRoot -RequestedServerDir $ServerDir
$serverPort = Get-ServerPort -ResolvedServerDir $resolvedServerDir
$serverJar = Find-ServerJar -ResolvedServerDir $resolvedServerDir

$state = @{
  projectRoot = $projectRoot
  updatedAt = (Get-Date).ToString("o")
  ollama = @{
    startedByScript = $ollamaState.startedByScript
    pid = $ollamaState.pid
  }
  server = @{
    startedByScript = $false
    pid = $null
    directory = $resolvedServerDir
    jar = $serverJar.Name
  }
  bot = @{
    startedByScript = $false
    pid = $null
  }
}

Write-Step "Configuring .env for local setup"
Set-OrAppendEnvLine -Path $envPath -Key "OLLAMA_URL" -Value "http://127.0.0.1:11434"
Set-OrAppendEnvLine -Path $envPath -Key "OLLAMA_MODEL" -Value $Model
Set-OrAppendEnvLine -Path $envPath -Key "MC_HOST" -Value "127.0.0.1"
Set-OrAppendEnvLine -Path $envPath -Key "MC_PORT" -Value "$serverPort"
Set-OrAppendEnvLine -Path $envPath -Key "MC_USERNAME" -Value $BotUsername
Set-OrAppendEnvLine -Path $envPath -Key "MC_AUTH" -Value "offline"
if ($AdminPlayers -and $AdminPlayers.Trim().Length -gt 0) {
  Set-OrAppendEnvLine -Path $envPath -Key "ADMIN_PLAYERS" -Value $AdminPlayers
}

Write-Step "Installing Node dependencies"
Set-Location -LiteralPath $projectRoot
& npm install
if ($LASTEXITCODE -ne 0) {
  throw "npm install failed."
}

Write-Step "Running TypeScript check"
& npm run check
if ($LASTEXITCODE -ne 0) {
  throw "npm run check failed."
}

if (-not $SkipServerStart) {
  Write-Step "Preparing Minecraft server EULA and starting server"
  $eulaPath = Join-Path $resolvedServerDir "eula.txt"
  Set-Content -LiteralPath $eulaPath -Value "eula=true`r`n" -Encoding ASCII

  $serverProcess = Start-Process `
    -FilePath "java" `
    -ArgumentList @("-Xms1G", "-Xmx2G", "-jar", $serverJar.Name, "nogui") `
    -WorkingDirectory $resolvedServerDir `
    -PassThru

  $state.server.startedByScript = $true
  $state.server.pid = $serverProcess.Id
  Write-Host "Minecraft server started (PID: $($serverProcess.Id)) using jar '$($serverJar.Name)'."
  Write-Host "Server folder: $resolvedServerDir"
}

Write-Step "Starting bot process"
$botProcess = Start-Process `
  -FilePath "npm.cmd" `
  -ArgumentList @("run", "dev") `
  -WorkingDirectory $projectRoot `
  -NoNewWindow `
  -PassThru
$state.bot.startedByScript = $true
$state.bot.pid = $botProcess.Id
$state.updatedAt = (Get-Date).ToString("o")
Save-State -StatePath $statePath -State $state

Write-Host "Bot started (PID: $($botProcess.Id))."
Write-Host "State file: $statePath"
Write-Host "Use Ctrl+C to stop this wrapper, or run scripts\\stop-system.ps1 from another terminal."

Wait-Process -Id $botProcess.Id
