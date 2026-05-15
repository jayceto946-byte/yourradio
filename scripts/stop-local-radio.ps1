param(
  [int]$RadioPort = 3100,
  [int]$TtsPort = 8010,
  [string]$ProjectRoot = ""
)

if (-not $ProjectRoot) { $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }

$ErrorActionPreference = "Continue"
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$logDir = Join-Path $resolvedProjectRoot "data"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir "local-shutdown.log"

function Write-LocalLog([string]$Message) {
  $line = "[$(Get-Date -Format o)] $Message"
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  Write-Host $Message
}

Write-LocalLog "Stopping Qwen3 TTS..."
& (Join-Path $resolvedProjectRoot "scripts\stop-qwen3-tts.ps1") -Port $TtsPort *>> $logPath

Start-Sleep -Seconds 1
Write-LocalLog "Stopping YourRadio dev server..."
& (Join-Path $resolvedProjectRoot "scripts\stop-yourradio.ps1") -Ports @(3000, $RadioPort) -ProjectRoot $resolvedProjectRoot *>> $logPath

Write-LocalLog "Local radio shutdown completed."
