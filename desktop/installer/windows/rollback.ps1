# Undo a PearTune Windows service install, leaving the machine as it was.
#
#   (in an ELEVATED PowerShell)  powershell -ExecutionPolicy Bypass -File C:\Users\Ben\rollback.ps1
#
# Written for the 2026-08-01 slice-3 rollback: the service installed and then
# refused to start, because copying the library changes the inode that
# hypercore-storage's device file stamps into store\CORESTORE. The approach
# changed to "no copy at all", so the copied library and the service both go.
#
# WHAT IT WILL NOT TOUCH: %APPDATA%\peartune-desktop\data. That is the real
# library - host.seed is the key every paired phone knows it by, and store\ is
# the grant list. Nothing regenerates either. The ProgramData copy is disposable
# precisely BECAUSE the original was never deleted.

$ErrorActionPreference = 'Continue'

function Say($m) { Write-Host "==> $m" }

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This needs an ELEVATED PowerShell (right-click > Run as administrator)." -ForegroundColor Red
  exit 1
}

$appData = [Environment]::GetFolderPath('ApplicationData')
$library = Join-Path $appData 'peartune-desktop\data'
$seed    = Join-Path $library 'host.seed'

# Refuse to do anything if the real library is not where we expect it. If it is
# already missing, something else is wrong and removing more is not the answer.
if (-not (Test-Path $seed)) {
  Write-Host "STOPPING: no library at $library - not touching anything." -ForegroundColor Red
  exit 1
}
$before = (Get-FileHash $seed -Algorithm SHA256).Hash.Substring(0,16)
Say "Real library found, identity $before - it will NOT be touched."

Say "Stopping and removing the service..."
$nssm = 'C:\Program Files\PearTune\resources\nssm.exe'
if (Test-Path $nssm) {
  & $nssm stop PearTuneHost 2>&1 | Out-Null
  & $nssm remove PearTuneHost confirm 2>&1 | Out-Null
}
sc.exe stop PearTuneHost 2>&1 | Out-Null
sc.exe delete PearTuneHost 2>&1 | Out-Null

Say "Stopping any running PearTune..."
Get-Process -Name 'PearTune' -ErrorAction SilentlyContinue | Stop-Process -Force

Say "Uninstalling the app (silently)..."
$uninst = 'C:\Program Files\PearTune\Uninstall PearTune.exe'
if (Test-Path $uninst) {
  Start-Process -Wait -FilePath $uninst -ArgumentList '/S'
  # -Wait IS NOT ENOUGH HERE. An NSIS uninstaller copies itself to %TEMP% and
  # relaunches from there, so the process we waited on exits almost immediately
  # while the real removal is still running. Reported "STILL PRESENT" for an
  # uninstall that had in fact worked (2026-08-01) - so poll for the outcome
  # rather than trusting the wait.
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Test-Path 'C:\Program Files\PearTune')) { break }
    Start-Sleep -Seconds 1
  }
}

Say "Removing the ProgramData copy (disposable - the original is untouched)..."
Remove-Item -Recurse -Force 'C:\ProgramData\PearTune' -ErrorAction SilentlyContinue

Write-Host ""
Say "RESULT"
$svc = sc.exe query PearTuneHost 2>&1 | Out-String
Write-Host ("  service        : " + $(if ($svc -match '1060') { 'gone' } else { 'STILL PRESENT' }))
Write-Host ("  ProgramData    : " + $(if (Test-Path 'C:\ProgramData\PearTune') { 'STILL PRESENT' } else { 'removed' }))
Write-Host ("  app installed  : " + $(if (Test-Path 'C:\Program Files\PearTune') { 'STILL PRESENT' } else { 'removed' }))
$after = if (Test-Path $seed) { (Get-FileHash $seed -Algorithm SHA256).Hash.Substring(0,16) } else { 'MISSING' }
Write-Host ("  your library   : " + $(if ($after -eq $before) { "INTACT ($after)" } else { "*** CHANGED: was $before, now $after ***" }))
