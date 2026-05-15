param(
  [int]$Port = 8010
)

$ErrorActionPreference = "Continue"

function Get-ListeningPids {
  param([int]$TargetPort)
  try {
    $lines = netstat -ano | Select-String -Pattern ":$TargetPort\s+.*LISTENING"
    return @($lines | ForEach-Object { ($_ -split "\s+")[-1] } | Where-Object { $_ -match "^\d+$" } | Sort-Object -Unique)
  } catch {
    return @()
  }
}

$processIds = New-Object System.Collections.Generic.HashSet[string]
foreach ($id in (Get-ListeningPids -TargetPort $Port)) { [void]$processIds.Add([string]$id) }
try {
  $qwenProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match "qwen3_tts_server" -or
    ($_.CommandLine -match "uvicorn" -and $_.CommandLine -match "8010")
  }
  foreach ($proc in $qwenProcesses) { [void]$processIds.Add([string]$proc.ProcessId) }
} catch {
  Write-Host "Unable to inspect Qwen3 TTS processes: $($_.Exception.Message)" -ForegroundColor Yellow
}

if (-not $processIds -or $processIds.Count -eq 0) {
  Write-Host "No Qwen3 TTS process found for port $Port." -ForegroundColor Yellow
  exit 0
}

foreach ($processId in @($processIds | Sort-Object -Unique)) {
  try {
    $proc = Get-Process -Id $processId -ErrorAction Stop
    Write-Host "Stopping Qwen3 TTS port $Port. PID: $processId ($($proc.ProcessName))" -ForegroundColor Cyan
    Stop-Process -Id $processId -Force
  } catch {
    Write-Host "Failed to stop PID $processId : $($_.Exception.Message)" -ForegroundColor Red
  }
}

Start-Sleep -Seconds 1
$remaining = Get-ListeningPids -TargetPort $Port
if ($remaining.Count -eq 0) {
  Write-Host "Qwen3 TTS stopped." -ForegroundColor Green
  exit 0
}
Write-Host "Port $Port is still occupied by PID(s): $($remaining -join ', ')" -ForegroundColor Red
exit 1
