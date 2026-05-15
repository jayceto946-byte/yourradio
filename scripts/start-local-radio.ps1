param(
  [int]$RadioPort = 3100,
  [int]$TtsPort = 8010,
  [string]$ProjectRoot = ""
)

if (-not $ProjectRoot) { $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }

$ErrorActionPreference = "Stop"
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path

Write-Host "Starting Qwen3 TTS in background..." -ForegroundColor Cyan
try {
  & (Join-Path $resolvedProjectRoot "scripts\start-qwen3-tts.ps1") -Port $TtsPort
} catch {
  Write-Host "Qwen3 TTS launch reported an error: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "YourRadio will still start; the frontend status bar will show TTS status." -ForegroundColor Yellow
}

Write-Host "Starting YourRadio in background..." -ForegroundColor Cyan
& (Join-Path $resolvedProjectRoot "scripts\start-yourradio-clean.ps1") -Port $RadioPort -SkipClean -ProjectRoot $resolvedProjectRoot

Write-Host "YourRadio is starting. Open http://localhost:$RadioPort" -ForegroundColor Green
