@echo off
REM Run the PearTune host on Windows WITHOUT installing Node.
REM
REM The desktop installer (PearTune Setup x.y.z.exe) already ships a Node runtime -
REM Electron's - and the host is plain Node, so ELECTRON_RUN_AS_NODE turns the
REM installed app into the node binary the host needs. Use this when you want the
REM always-on daemon on a Windows box but not the tray app in the foreground (a
REM headless test rig, a spare machine, a VM). The tray app itself, and the
REM node-from-source path, are both in docs/host-macos-windows.md.
REM
REM Start it detached (it holds the console otherwise):
REM   powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c','%%~f0' -WindowStyle Hidden"
REM
REM Edit MUSIC/DATA below, or set them in the environment before calling this.

set ELECTRON_RUN_AS_NODE=1
set PEARTUNE_APP=%LOCALAPPDATA%\Programs\PearTune
if "%MUSIC%"=="" set MUSIC=%USERPROFILE%\Music

REM THE DATA DIR IS THE LIBRARY'S IDENTITY - the host key every paired phone dials. Default to the
REM TRAY APP's own data dir when it exists, so running headless CONTINUES that library instead of
REM minting a second one. Get this wrong and every phone silently stops finding the library: the
REM host is up, the dashboard answers, and the key it announces is one nobody paired with.
REM (The installer auto-launches the tray app after a silent /S install, so on a machine where you
REM have ever run the installer, that dir is the one that already holds your grants.)
if "%DATA%"=="" (
  if exist "%APPDATA%\peartune-desktop\data" (
    set DATA=%APPDATA%\peartune-desktop\data
  ) else (
    set DATA=%USERPROFILE%\.peartune
  )
)

if not exist "%PEARTUNE_APP%\PearTune.exe" (
  echo PearTune is not installed at "%PEARTUNE_APP%".
  echo Install it first, or edit PEARTUNE_APP above.
  exit /b 1
)

"%PEARTUNE_APP%\PearTune.exe" "%PEARTUNE_APP%\resources\app.asar\vendor\host\index.js" --music "%MUSIC%" --data "%DATA%" %*
