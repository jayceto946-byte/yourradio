param(
  [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) { $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$logDir = Join-Path $resolvedProjectRoot "data"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir "yourradio-update.log"

function Write-UpdateLog([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date).ToString("s"), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  Write-Host $Message
}

Set-Location -LiteralPath $resolvedProjectRoot
Write-UpdateLog "Starting YourRadio update in $resolvedProjectRoot"

$beforeLock = ""
if (Test-Path -LiteralPath "package-lock.json") {
  $beforeLock = (Get-FileHash -LiteralPath "package-lock.json" -Algorithm SHA256).Hash
}

Write-UpdateLog "Running git pull --rebase --autostash"
git pull --rebase --autostash *>> $logPath
if ($LASTEXITCODE -ne 0) {
  Write-UpdateLog "git pull failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}

$afterLock = ""
if (Test-Path -LiteralPath "package-lock.json") {
  $afterLock = (Get-FileHash -LiteralPath "package-lock.json" -Algorithm SHA256).Hash
}

if ($beforeLock -ne $afterLock) {
  Write-UpdateLog "package-lock.json changed; running npm install"
  npm install *>> $logPath
  if ($LASTEXITCODE -ne 0) {
    Write-UpdateLog "npm install failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
  }
} else {
  Write-UpdateLog "package-lock.json unchanged; skipping npm install"
}

Write-UpdateLog "Update completed. Restart YourRadio if it is already running."
exit 0
