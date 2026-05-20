param(
  [int]$RadioPort = 3100,
  [int]$TtsPort = 8010,
  [string]$ProjectRoot = "",
  [int]$TtsHealthWaitSec = 90
)

if (-not $ProjectRoot) { $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }

$ErrorActionPreference = "Stop"
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$logDir = Join-Path $resolvedProjectRoot "data"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-TtsHealth {
  param([int]$Port, [int]$TimeoutSec = 3)
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec $TimeoutSec
    return $health
  } catch {
    return $null
  }
}

function Wait-TtsHealth {
  param([int]$Port, [int]$WaitSec)
  $deadline = (Get-Date).AddSeconds($WaitSec)
  do {
    $health = Test-TtsHealth -Port $Port -TimeoutSec 3
    if ($health) { return $health }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $null
}

Write-Host "Starting Qwen3 TTS in background..." -ForegroundColor Cyan
$ttsStarted = $false
$startTtsScript = Join-Path $resolvedProjectRoot "scripts\start-qwen3-tts.ps1"
$ttsLauncherOut = Join-Path $logDir "qwen3-tts-launcher.out.log"
$ttsLauncherErr = Join-Path $logDir "qwen3-tts-launcher.err.log"
Remove-Item -LiteralPath $ttsLauncherOut,$ttsLauncherErr -ErrorAction SilentlyContinue

$existingHealth = Test-TtsHealth -Port $TtsPort -TimeoutSec 2
if ($existingHealth) {
  $ttsStarted = $true
  Write-Host "Qwen3 TTS is already reachable on http://127.0.0.1:$TtsPort" -ForegroundColor Green
} else {
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $startTtsScript, "-Port", "$TtsPort") -WorkingDirectory $resolvedProjectRoot -WindowStyle Hidden -RedirectStandardOutput $ttsLauncherOut -RedirectStandardError $ttsLauncherErr | Out-Null

  $health = Wait-TtsHealth -Port $TtsPort -WaitSec $TtsHealthWaitSec
  if ($health) {
    $ttsStarted = $true
    Write-Host "Qwen3 TTS is reachable on http://127.0.0.1:$TtsPort" -ForegroundColor Green
  } else {
    Write-Host "Qwen3 TTS did not become reachable within $TtsHealthWaitSec seconds." -ForegroundColor Yellow
    Write-Host "Check: .\scripts\check-qwen3-tts.ps1" -ForegroundColor Yellow
    Write-Host "Launcher logs:" -ForegroundColor Yellow
    Write-Host "  $ttsLauncherOut" -ForegroundColor Yellow
    Write-Host "  $ttsLauncherErr" -ForegroundColor Yellow
  }
}

Write-Host "Starting YourRadio in background..." -ForegroundColor Cyan
$startRadioScript = Join-Path $resolvedProjectRoot "scripts\start-yourradio-clean.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startRadioScript -Port $RadioPort -SkipClean -ProjectRoot $resolvedProjectRoot
$radioExitCode = $LASTEXITCODE
if ($radioExitCode -ne 0) {
  Write-Host "YourRadio launch exited with code $radioExitCode." -ForegroundColor Yellow
}

Write-Host "YourRadio is starting. Open http://localhost:$RadioPort" -ForegroundColor Green
if (-not $ttsStarted) {
  Write-Host "TTS is not confirmed online. Run .\scripts\check-qwen3-tts.ps1 for details." -ForegroundColor Yellow
}
