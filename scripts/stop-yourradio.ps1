param(
  [int[]]$Ports = @(3000, 3100),
  [string]$ProjectRoot = ""
)

if (-not $ProjectRoot) { $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }

$ErrorActionPreference = "Continue"
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$targetIds = New-Object System.Collections.Generic.HashSet[int]

function Add-ListeningProcessIds {
  param([int[]]$TargetPorts)
  foreach ($port in $TargetPorts) {
    try {
      $connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction Stop
      foreach ($conn in $connections) { [void]$targetIds.Add([int]$conn.OwningProcess) }
    } catch {
      Write-Host "Port $port is free." -ForegroundColor DarkGray
    }
  }
}

function Add-ProjectNodeProcessIds {
  param([string]$Root)
  try {
    $escapedRoot = [regex]::Escape($Root)
    $processes = Get-CimInstance Win32_Process | Where-Object {
      ($_.Name -like "node*" -or $_.Name -like "npm*" -or $_.CommandLine -match "next") -and
      ($_.CommandLine -match $escapedRoot -or $_.CommandLine -match "next[/\\]dist[/\\]bin[/\\]next" -or $_.CommandLine -match "next dev")
    }
    foreach ($proc in $processes) { [void]$targetIds.Add([int]$proc.ProcessId) }
  } catch {
    Write-Host "Unable to inspect Node processes: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

Add-ListeningProcessIds -TargetPorts $Ports
Add-ProjectNodeProcessIds -Root $resolvedProjectRoot

$currentPid = $PID
$ids = @($targetIds | Where-Object { $_ -ne $currentPid } | Sort-Object -Unique)
if ($ids.Count -eq 0) {
  Write-Host "No YourRadio dev server process found." -ForegroundColor Green
  exit 0
}

foreach ($processId in $ids) {
  try {
    $proc = Get-Process -Id $processId -ErrorAction Stop
    Write-Host "Stopping YourRadio process PID $processId ($($proc.ProcessName))" -ForegroundColor Cyan
    Stop-Process -Id $processId -Force -ErrorAction Stop
  } catch {
    Write-Host "Failed to stop PID $processId : $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

Start-Sleep -Seconds 1
$remaining = @()
foreach ($port in $Ports) {
  try {
    $remaining += Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique
  } catch {}
}
$remaining = @($remaining | Sort-Object -Unique)
if ($remaining.Count -gt 0) {
  Write-Host "Some requested port(s) are still occupied by PID(s): $($remaining -join ', ')" -ForegroundColor Red
  exit 1
}

Write-Host "YourRadio dev server stopped." -ForegroundColor Green
