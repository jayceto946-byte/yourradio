param(
  [int]$Port = 8010,
  [int]$TimeoutSec = 5
)

$ErrorActionPreference = "Continue"
$BaseUrl = "http://127.0.0.1:$Port"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

function Get-ListeningPids {
  param([int]$TargetPort)
  try {
    $lines = netstat -ano | Select-String -Pattern ":$TargetPort\s+.*LISTENING"
    return @($lines | ForEach-Object { ($_ -split "\s+")[-1] } | Where-Object { $_ -match "^\d+$" } | Sort-Object -Unique)
  } catch {
    return @()
  }
}

Write-Host "Checking Qwen3 TTS: $BaseUrl" -ForegroundColor Cyan
$pids = Get-ListeningPids -TargetPort $Port
if ($pids.Count -gt 0) {
  Write-Host "Port $Port is listening. PID(s): $($pids -join ', ')" -ForegroundColor DarkGray
} else {
  Write-Host "Port $Port is not listening." -ForegroundColor Yellow
}

try {
  $started = Get-Date
  $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec $TimeoutSec
  $elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
  if ($health.ok -eq $false) {
    Write-Host "Qwen3 TTS responded but reports ok=false." -ForegroundColor Yellow
  } else {
    Write-Host "Qwen3 TTS is reachable." -ForegroundColor Green
  }
  [pscustomobject]@{
    ok = [bool]($health.ok -ne $false)
    url = "$BaseUrl/health"
    latencyMs = $elapsedMs
    provider = $health.provider
    model = $health.model
    device = $health.device
    dtype = $health.dtype
    speaker = $health.speaker
    loaded = $health.loaded
    pids = $pids
  } | ConvertTo-Json -Depth 5
  exit 0
} catch {
  Write-Host "Qwen3 TTS health check timed out or failed." -ForegroundColor Red
  if ($pids.Count -gt 0) {
    Write-Host "A process is listening on the port, so it may be busy loading/generating or hung." -ForegroundColor Yellow
    foreach ($processId in $pids) {
      $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if ($proc) { Write-Host "  PID ${processId}: $($proc.ProcessName), WorkingSet=$([math]::Round($proc.WorkingSet64 / 1MB, 1)) MB, CPU=$($proc.CPU)" -ForegroundColor DarkGray }
    }
    Write-Host "If it stays like this for more than a few minutes, restart it with:" -ForegroundColor Yellow
    Write-Host "  cd $ProjectRoot" -ForegroundColor Yellow
    Write-Host "  .\scripts\stop-qwen3-tts.ps1" -ForegroundColor Yellow
    Write-Host "  .\scripts\start-qwen3-tts.ps1" -ForegroundColor Yellow
  } else {
    Write-Host "Start it with:" -ForegroundColor Yellow
    Write-Host "  cd $ProjectRoot" -ForegroundColor Yellow
    Write-Host "  .\scripts\start-qwen3-tts.ps1" -ForegroundColor Yellow
  }
  $stdoutLog = Join-Path $ProjectRoot "data\qwen3-tts-server.out.log"
  $stderrLog = Join-Path $ProjectRoot "data\qwen3-tts-server.err.log"
  if (Test-Path $stderrLog) { Write-Host "Recent stderr:" -ForegroundColor DarkGray; Get-Content -LiteralPath $stderrLog -Tail 20 }
  if (Test-Path $stdoutLog) { Write-Host "Recent stdout:" -ForegroundColor DarkGray; Get-Content -LiteralPath $stdoutLog -Tail 20 }
  [pscustomobject]@{ ok = $false; url = "$BaseUrl/health"; error = $_.Exception.Message; pids = $pids } | ConvertTo-Json -Depth 5
  exit 1
}
