param(
  [int]$Port = 4319,
  [switch]$NoBrowser,
  [switch]$Fallback,
  [string]$NodePath
)

$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot
$nodeCommand = if ($NodePath) { Get-Item -LiteralPath $NodePath -ErrorAction SilentlyContinue } else { Get-Command node -ErrorAction SilentlyContinue }
if (-not $nodeCommand) {
  Write-Error "Codex Session Map requires Node >= 24. Node was not found on PATH."
  exit 1
}

$nodeExecutable = if ($nodeCommand.Source) { $nodeCommand.Source } else { $nodeCommand.FullName }
& $nodeExecutable (Join-Path $projectRoot "scripts\check-node-version.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

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
