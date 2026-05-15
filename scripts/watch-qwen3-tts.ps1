param(
  [int]$Port = 8010,
  [int]$IntervalSec = 2,
  [int]$HealthTimeoutSec = 2,
  [int]$Tail = 12
)

$ErrorActionPreference = "Continue"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BaseUrl = "http://127.0.0.1:$Port"
$StdoutLog = Join-Path $ProjectRoot "data\qwen3-tts-server.out.log"
$StderrLog = Join-Path $ProjectRoot "data\qwen3-tts-server.err.log"
$RuntimeLog = Join-Path $ProjectRoot "data\logs\runtime-events.jsonl"
$CacheDir = Join-Path $ProjectRoot "data\tts-cache"

function Get-ListeningPids {
  param([int]$TargetPort)
  try {
    $lines = netstat -ano | Select-String -Pattern ":$TargetPort\s+.*LISTENING"
    return @($lines | ForEach-Object { ($_ -split "\s+")[-1] } | Where-Object { $_ -match "^\d+$" } | Sort-Object -Unique)
  } catch {
    return @()
  }
}

function Get-Health {
  try {
    $started = Get-Date
    $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec $HealthTimeoutSec
    $latencyMs = [int]((Get-Date) - $started).TotalMilliseconds
    return [pscustomobject]@{ ok = $true; latencyMs = $latencyMs; data = $health; error = $null }
  } catch {
    return [pscustomobject]@{ ok = $false; latencyMs = $null; data = $null; error = $_.Exception.Message }
  }
}

function Get-ProcessRows {
  param([string[]]$Pids)
  $rows = @()
  foreach ($processId in $Pids) {
    $proc = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
    if ($proc) {
      $rows += [pscustomobject]@{
        PID = $processId
        Name = $proc.ProcessName
        CPU = if ($null -ne $proc.CPU) { [math]::Round($proc.CPU, 1) } else { $null }
        RAM_MB = [math]::Round($proc.WorkingSet64 / 1MB, 1)
        StartTime = try { $proc.StartTime.ToString("HH:mm:ss") } catch { "" }
      }
    }
  }
  return $rows
}

function Get-CacheStats {
  if (-not (Test-Path $CacheDir)) {
    return [pscustomobject]@{ Count = 0; SizeMB = 0; Newest = "" }
  }
  $files = @(Get-ChildItem -LiteralPath $CacheDir -Filter *.wav -File -ErrorAction SilentlyContinue)
  $size = ($files | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $size) { $size = 0 }
  $newest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  return [pscustomobject]@{
    Count = $files.Count
    SizeMB = [math]::Round($size / 1MB, 1)
    Newest = if ($newest) { "$($newest.Name) $($newest.LastWriteTime.ToString('HH:mm:ss'))" } else { "" }
  }
}

function Show-RuntimeTtsEvents {
  if (-not (Test-Path $RuntimeLog)) {
    Write-Host "No runtime log yet: $RuntimeLog" -ForegroundColor DarkGray
    return
  }
  $events = Get-Content -LiteralPath $RuntimeLog -Tail 300 -ErrorAction SilentlyContinue |
    Where-Object { $_ -match '"step":"tts\.' -or $_ -match '"step":"rollingQueue\.refill"' -or $_ -match '"step":"api\.next"' } |
    Select-Object -Last $Tail
  foreach ($line in $events) {
    try {
      $e = $line | ConvertFrom-Json
      $time = ([datetime]$e.createdAt).ToLocalTime().ToString("HH:mm:ss")
      $duration = if ($null -ne $e.durationMs) { " $($e.durationMs)ms" } else { "" }
      $extra = ""
      if ($e.context.track) { $extra += " track=$($e.context.track)" }
      if ($e.context.provider) { $extra += " provider=$($e.context.provider)" }
      if ($e.context.hasTts -ne $null) { $extra += " hasTts=$($e.context.hasTts)" }
      if ($e.context.fallback) { $extra += " fallback=$($e.context.fallback)" }
      if ($e.error) { $extra += " error=$($e.error)" }
      $color = if ($e.status -eq "error") { "Red" } elseif ($e.status -eq "started") { "Yellow" } elseif ($e.status -eq "success") { "Green" } else { "Gray" }
      Write-Host "$time [$($e.status)] $($e.step)$duration$extra" -ForegroundColor $color
    } catch {
      Write-Host $line -ForegroundColor DarkGray
    }
  }
}

while ($true) {
  Clear-Host
  $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Host "YourRadio Qwen3 TTS Watch  $now" -ForegroundColor Cyan
  Write-Host "BaseUrl: $BaseUrl    Refresh: ${IntervalSec}s    Exit: Ctrl+C" -ForegroundColor DarkGray
  Write-Host ""

  $pids = Get-ListeningPids -TargetPort $Port
  if ($pids.Count -eq 0) {
    Write-Host "Port $Port is NOT listening." -ForegroundColor Red
    Write-Host "Start: cd $ProjectRoot; .\scripts\start-qwen3-tts.ps1" -ForegroundColor Yellow
  } else {
    Write-Host "Port $Port listening. PID(s): $($pids -join ', ')" -ForegroundColor Green
    Get-ProcessRows -Pids $pids | Format-Table -AutoSize
  }

  $health = Get-Health
  if ($health.ok) {
    $h = $health.data
    Write-Host "Health: OK  latency=$($health.latencyMs)ms  loaded=$($h.loaded)  speaker=$($h.speaker)  device=$($h.device)  dtype=$($h.dtype)" -ForegroundColor Green
    Write-Host "Model: $($h.model)" -ForegroundColor DarkGray
  } else {
    Write-Host "Health: FAILED  $($health.error)" -ForegroundColor Red
  }

  $cache = Get-CacheStats
  Write-Host "Cache: $($cache.Count) wav, $($cache.SizeMB) MB, newest: $($cache.Newest)" -ForegroundColor Cyan
  Write-Host ""

  Write-Host "Recent TTS / playback events:" -ForegroundColor Cyan
  Show-RuntimeTtsEvents
  Write-Host ""

  if (Test-Path $StderrLog) {
    Write-Host "Recent qwen stderr:" -ForegroundColor Cyan
    Get-Content -LiteralPath $StderrLog -Tail 6 -ErrorAction SilentlyContinue
  }

  Start-Sleep -Seconds $IntervalSec
}