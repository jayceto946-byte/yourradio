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

function Invoke-ProjectScript {
  param([string]$ScriptPath, [string[]]$Arguments = @())
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments *>> $logPath
  return $LASTEXITCODE
}

Write-LocalLog "Stopping Qwen3 TTS..."
$stopTtsScript = Join-Path $resolvedProjectRoot "scripts\stop-qwen3-tts.ps1"
$ttsExitCode = Invoke-ProjectScript -ScriptPath $stopTtsScript -Arguments @("-Port", "$TtsPort")
Write-LocalLog "Qwen3 TTS stop exit code: $ttsExitCode"

Start-Sleep -Seconds 1
Write-LocalLog "Stopping YourRadio dev server..."
$stopRadioScript = Join-Path $resolvedProjectRoot "scripts\stop-yourradio.ps1"
$radioExitCode = Invoke-ProjectScript -ScriptPath $stopRadioScript -Arguments @("-Ports", "3000", "$RadioPort", "-ProjectRoot", $resolvedProjectRoot)
Write-LocalLog "YourRadio stop exit code: $radioExitCode"

Write-LocalLog "Local radio shutdown completed."
if ($ttsExitCode -ne 0 -or $radioExitCode -ne 0) { exit 1 }
exit 0
