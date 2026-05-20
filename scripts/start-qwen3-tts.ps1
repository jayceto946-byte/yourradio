param(
  [int]$Port = 8010,
  [string]$PythonPath = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$EnvFile = Join-Path $ProjectRoot ".env.local"
if (Test-Path -LiteralPath $EnvFile) {
  Get-Content -LiteralPath $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $parts = $line.Split("=", 2)
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($name -and -not (Test-Path "Env:$name")) {
      Set-Item -Path "Env:$name" -Value $value
    }
  }
}
if (-not $PythonPath) { $PythonPath = $env:QWEN3_TTS_PYTHON_PATH }
if (-not $PythonPath) {
  $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($pythonCommand) { $PythonPath = $pythonCommand.Source }
}
$ServerDir = Join-Path $ProjectRoot "tools\qwen3-tts-server"
$LogDir = Join-Path $ProjectRoot "data"
$StdoutLog = Join-Path $LogDir "qwen3-tts-server.out.log"
$StderrLog = Join-Path $LogDir "qwen3-tts-server.err.log"
$AiCacheRoot = $env:YOURRADIO_AI_CACHE_ROOT
if (-not $AiCacheRoot) { $AiCacheRoot = Join-Path $env:LOCALAPPDATA "YourRadio\cache" }
$HuggingFaceCacheRoot = Join-Path $AiCacheRoot "huggingface"
$PipCacheRoot = Join-Path $AiCacheRoot "pip"
$SoxDir = $env:YOURRADIO_SOX_DIR
if (-not $SoxDir) { $SoxDir = "" }

function Get-ListeningPid {
  param([int]$TargetPort)
  try {
    $line = netstat -ano | Select-String -Pattern ":$TargetPort\s+.*LISTENING" | Select-Object -First 1
    if (-not $line) { return $null }
    return [int](($line -split "\s+")[-1])
  } catch {
    return $null
  }
}
function Test-SoxAvailable {
  return [bool](Get-Command sox -ErrorAction SilentlyContinue)
}
function Test-Health {
  param([int]$TargetPort)
  try {
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$TargetPort/health" -TimeoutSec 3
    return $result
  } catch {
    return $null
  }
}

if ($SoxDir -and (Test-Path (Join-Path $SoxDir "sox.exe")) -and -not (Test-SoxAvailable)) {
  $env:PATH = "$SoxDir;$env:PATH"
}
if (-not (Test-SoxAvailable)) {
  Write-Error "SoX executable was not found. qwen-tts imports the Python sox package, which requires sox.exe. Set YOURRADIO_SOX_DIR or install sox.portable."
}
if (-not $PythonPath -or -not (Test-Path $PythonPath)) {
  Write-Error "Python not found: $PythonPath`nIf your env is elsewhere, run: .\scripts\start-qwen3-tts.ps1 -PythonPath <your-python.exe>"
}

if (-not (Test-Path $ServerDir)) {
  Write-Error "Server directory not found: $ServerDir"
}

$existingPid = Get-ListeningPid -TargetPort $Port
if ($existingPid) {
  $health = Test-Health -TargetPort $Port
  if ($health) {
    Write-Host "Qwen3 TTS is already running on port $Port. PID: $existingPid" -ForegroundColor Green
    $health | ConvertTo-Json -Depth 5
    exit 0
  }

  Write-Host "Port $Port is occupied by PID $existingPid, but /health is not reachable. Stopping stale process first..." -ForegroundColor Yellow
  try { Stop-Process -Id $existingPid -Force -ErrorAction Stop; Start-Sleep -Seconds 1 } catch { Write-Host "Failed to stop stale PID $existingPid : $($_.Exception.Message)" -ForegroundColor Yellow }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $HuggingFaceCacheRoot "hub") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $HuggingFaceCacheRoot "transformers") | Out-Null
New-Item -ItemType Directory -Force -Path $PipCacheRoot | Out-Null
Remove-Item -LiteralPath $StdoutLog,$StderrLog -ErrorAction SilentlyContinue

$env:HF_HOME = $HuggingFaceCacheRoot
$env:HUGGINGFACE_HUB_CACHE = Join-Path $HuggingFaceCacheRoot "hub"
# Keep legacy Transformers cache aligned with the Hub cache. A partial
# transformers cache can make qwen-tts fail while loading speech_tokenizer.
$env:TRANSFORMERS_CACHE = $env:HUGGINGFACE_HUB_CACHE
$env:PIP_CACHE_DIR = $PipCacheRoot
if ($SoxDir -and (Test-Path (Join-Path $SoxDir "sox.exe"))) { $env:PATH = "$SoxDir;$env:PATH" }

Write-Host "Starting Qwen3 TTS on http://127.0.0.1:$Port ..." -ForegroundColor Cyan
Write-Host "Python: $PythonPath"
Write-Host "Server: $ServerDir"
Write-Host "HF cache: $env:HF_HOME"
Write-Host "pip cache: $env:PIP_CACHE_DIR"
Write-Host "SoX: $SoxDir"

$process = Start-Process `
  -FilePath $PythonPath `
  -ArgumentList @("-m", "uvicorn", "qwen3_tts_server:app", "--host", "127.0.0.1", "--port", "$Port") `
  -WorkingDirectory $ServerDir `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -WindowStyle Hidden `
  -PassThru

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  $health = Test-Health -TargetPort $Port
  if ($health) {
    Write-Host "Qwen3 TTS started. PID: $($process.Id)" -ForegroundColor Green
    $health | ConvertTo-Json -Depth 5
    Write-Host "Logs:" -ForegroundColor DarkGray
    Write-Host "  $StdoutLog" -ForegroundColor DarkGray
    Write-Host "  $StderrLog" -ForegroundColor DarkGray
    exit 0
  }

  if ($process.HasExited) {
    Write-Host "Qwen3 TTS failed to start. Last stderr:" -ForegroundColor Red
    if (Test-Path $StderrLog) { Get-Content $StderrLog -Tail 80 }
    exit 1
  }
}

Write-Host "Qwen3 TTS process started but /health did not respond within 30 seconds. It may still be loading the model. PID: $($process.Id)" -ForegroundColor Yellow
Write-Host "Check logs:" -ForegroundColor Yellow
Write-Host "  $StdoutLog"
Write-Host "  $StderrLog"
exit 0

