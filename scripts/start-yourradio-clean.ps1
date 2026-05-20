param(
  [int]$Port = 3100,
  [switch]$SkipClean,
  [string]$ProjectRoot = ""
)

if (-not $ProjectRoot) { $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }

$ErrorActionPreference = "Stop"
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path

Write-Host "Stopping existing YourRadio dev server..." -ForegroundColor Cyan
$stopRadioScript = Join-Path $resolvedProjectRoot "scripts\stop-yourradio.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopRadioScript -Ports 3000 3100 -ProjectRoot $resolvedProjectRoot

if (-not $SkipClean) {
  $nextDir = Join-Path $resolvedProjectRoot ".next"
  if (Test-Path -LiteralPath $nextDir) {
    Write-Host "Removing stale .next cache..." -ForegroundColor Cyan
    Remove-Item -LiteralPath $nextDir -Recurse -Force
  } else {
    Write-Host ".next cache does not exist." -ForegroundColor DarkGray
  }
}

Write-Host "Starting YourRadio on http://localhost:$Port ..." -ForegroundColor Green
$logDir = Join-Path $resolvedProjectRoot "data"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "yourradio-dev.out.log"
$errLog = Join-Path $logDir "yourradio-dev.err.log"
$command = "node scripts/kill-port.js $Port && node --max-old-space-size=4096 node_modules/next/dist/bin/next dev -p $Port"
Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $command) -WorkingDirectory $resolvedProjectRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Write-Host "Started in the background. Open http://localhost:$Port" -ForegroundColor DarkGray
Write-Host "Logs:" -ForegroundColor DarkGray
Write-Host "  $outLog" -ForegroundColor DarkGray
Write-Host "  $errLog" -ForegroundColor DarkGray
