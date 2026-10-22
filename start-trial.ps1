# start-trial.ps1 - try the system locally on Windows before deploying to the VPS.
#
#   powershell -ExecutionPolicy Bypass -File .\start-trial.ps1          # start (creates the trial DB on first run)
#   powershell -ExecutionPolicy Bypass -File .\start-trial.ps1 -Reset   # wipe the trial data and start fresh
#
# Uses its own database (backend\trial.sqlite3) and blob folder, so the dev
# database is never touched. Demo accounts (seed_demo):
#   ahmed / Ahmed@12345     mohamed / Mohamed@12345     sara / Sara@12345
#   manager / Manager@12345 (branch manager - announcements, reports)
#   admin / Admin@12345     (system admin - employees and org structure)
#
# IMPORTANT: use a SEPARATE browser or browser profile per account (e.g. Chrome
# for ahmed, Edge for mohamed). Each browser profile is one "device" holding
# that user's private keys; switching accounts in the same profile mixes them.
param([switch]$Reset)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $root '.venv\Scripts\python.exe'
$db = Join-Path $root 'backend\trial.sqlite3'
$blobs = Join-Path $root 'backend\var\trial-blobs'

if (-not (Test-Path $py)) { throw "Python venv not found at $py (see AGENTS.md)" }

# Child processes inherit these.
$env:DATABASE_URL = 'sqlite:///' + ($db -replace '\\', '/')
$env:ENCRYPTED_BLOB_ROOT = $blobs
$env:PYTHONWARNINGS = 'ignore'

function Test-Port([int]$port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

if (Test-Port 8000) {
    Write-Host "Port 8000 is busy - stop the running backend first (it may be an older version)." -ForegroundColor Yellow
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -like '*runserver*8000*' } |
        ForEach-Object { Write-Host ("  PID {0}: {1}" -f $_.ProcessId, $_.CommandLine) }
    exit 1
}

if ($Reset) {
    Write-Host 'Resetting trial data...'
    Remove-Item -Force -ErrorAction SilentlyContinue $db
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $blobs
    # New accounts get new ids, and the browser keeps one local key store per
    # user id, so stale keys from the previous run are simply never opened.
}

$fresh = -not (Test-Path $db)
Push-Location (Join-Path $root 'backend')
try {
    & $py manage.py migrate -v 0
    if ($fresh) {
        & $py manage.py seed_demo | Out-Null
        Write-Host 'Trial database created with demo accounts.'
    }
} finally { Pop-Location }

Write-Host 'Starting backend on http://localhost:8000 ...'
Start-Process powershell -WorkingDirectory (Join-Path $root 'backend') -ArgumentList @(
    '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle='backend (trial)'; & '$py' manage.py runserver 127.0.0.1:8000"
)

if (-not (Test-Port 5173)) {
    Write-Host 'Starting frontend on http://localhost:5173 ...'
    Start-Process powershell -WorkingDirectory (Join-Path $root 'frontend') -ArgumentList @(
        '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle='frontend'; npm run dev"
    )
} else {
    Write-Host 'Frontend already running on http://localhost:5173'
}

Start-Sleep -Seconds 4
Start-Process 'http://localhost:5173'
Write-Host ''
Write-Host 'Accounts: ahmed/Ahmed@12345  mohamed/Mohamed@12345  sara/Sara@12345  manager/Manager@12345  admin/Admin@12345'
Write-Host 'One browser (or profile) per account.' -ForegroundColor Cyan
