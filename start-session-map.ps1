param(
  [int]$Port = 4319,
  [switch]$NoBrowser,
  [switch]$Fallback,
  [string]$NodePath
)

$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot
$nodeCandidates = if ($NodePath) {
  @($NodePath)
} else {
  @(
    Get-Command node -All -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandType -eq "Application" } |
      ForEach-Object { $_.Source }
  ) + @(
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"),
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
  )
}

$nodeExecutable = $null
$detectedVersions = @()
foreach ($candidate in ($nodeCandidates | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  $version = & $candidate --version 2>$null
  if ($LASTEXITCODE -ne 0) { continue }
  if ($version -match '^v?(\d+)\.') { $major = [int]$Matches[1] } else { continue }
  $detectedVersions += "$version ($candidate)"
  if ($major -ge 24) { $nodeExecutable = $candidate; break }
}
if (-not $nodeExecutable) {
  $found = if ($detectedVersions.Count) { $detectedVersions -join ", " } else { "none" }
  Write-Error "Codex Session Map requires Node >= 24. Found: $found. Install Node 24 or pass -NodePath C:\path\to\node.exe."
  exit 1
}

Write-Host "Using Node $version from $nodeExecutable"
& $nodeExecutable (Join-Path $projectRoot "scripts\check-node-version.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# The same Node executable must also run pnpm's build when -NodePath is used.
$env:PATH = "$(Split-Path -Parent $nodeExecutable);$env:PATH"

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCommand) { throw "Codex Session Map requires pnpm to build the Map Workspace." }
& $pnpmCommand.Source --dir $projectRoot build:map
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$serverArguments = @("apps/local-web/src/main.ts", "--port", [string]$Port)
if ($Fallback) { $serverArguments += "--no-app-server" }
$server = Start-Process -FilePath $nodeExecutable -ArgumentList $serverArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
$url = "http://127.0.0.1:$Port"

try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
    if ($server.HasExited) { throw "Codex Session Map stopped during startup (exit code $($server.ExitCode))." }
    try {
      $response = Invoke-WebRequest -UseBasicParsing "$url/api/health" -TimeoutSec 1
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $ready) { throw "Codex Session Map did not become ready at $url." }
  Write-Host "Codex Session Map v0.2.0-beta.1 is ready: $url"
  Write-Host "Server PID: $($server.Id). Press Ctrl+C to stop."
  if (-not $NoBrowser) { Start-Process $url }
  Wait-Process -Id $server.Id
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id }
}
