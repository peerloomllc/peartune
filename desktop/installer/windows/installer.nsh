; PearTune Windows service registration (slice 3 of
; proposals/2026-07-31-desktop-host-as-a-service.md).
;
; electron-builder includes this and calls the two macros below from its own
; installer. Everything here runs ELEVATED, because `nsis.perMachine` is true -
; registering a service needs admin, and there is no way around that.
;
; THE SHAPE, and how it differs from the PearCircle seeder's version this is
; modelled on: the seeder ships its own node.exe and runs `node host-bundled.js`.
; PearTune ships Electron, so the service runs the SAME installed binary with
; ELECTRON_RUN_AS_NODE=1, which turns it into plain Node. That variable is not
; optional decoration - without it Windows launches a GUI app as a service, in
; session 0 where it can never show a window, and it does nothing useful.
;
; Electron is not SCM-aware (it never calls StartServiceCtrlDispatcher), so it
; cannot be a service directly - Windows would start it and then mark the service
; failed. nssm.exe supervises it as an ordinary process instead. Public domain,
; 324K, the same binary the seeder already ships.
;
; WHY package.json SETS nsis.perMachine = true, since it is easy to "tidy" away:
; registering a Windows service needs admin, and a per-user install cannot do it.
; That makes the Windows install elevated (a UAC prompt) where it used to be
; per-user and silent - which also invalidated a claim in
; proposals/2026-07-31-desktop-update-apply.md that a Windows update could
; self-apply without elevation. See the 2026-08-01 addendum there. The answer is
; the seeder's: the LocalSystem service, already elevated, drives its own update.

!define SVC_NAME "PearTuneHost"

!macro customInstall
  DetailPrint "Registering the PearTune host service..."

  ; $%VAR% in NSIS is expanded at COMPILE time - it would bake in the BUILD
  ; machine's environment, which on our Linux cross-build is nothing at all (that
  ; is the "unknown variable/constant" the compiler rejects). ExpandEnvStrings is
  ; the runtime form, and the target machine's ProgramData is what we need.
  ExpandEnvStrings $1 "%ProgramData%"

  ; Remove anything a previous version left behind, before installing over it. A
  ; running service holds the binary open and the install would fail half-done.
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" stop ${SVC_NAME}'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" remove ${SVC_NAME} confirm'
  nsExec::ExecToLog 'sc.exe stop ${SVC_NAME}'
  nsExec::ExecToLog 'sc.exe delete ${SVC_NAME}'

  ; NO MIGRATION. THE SERVICE READS THE LIBRARY WHERE IT ALREADY LIVES.
  ;
  ; This slice originally copied the library to ProgramData so a LocalSystem
  ; service would own it machine-wide. That was built, byte-verified, and DID NOT
  ; WORK - found by installing it on real Windows (2026-08-01). hypercore-storage
  ; stamps store\CORESTORE through the `device-file` package, which records the
  ; file's INODE and re-checks it on open (device-file/index.js:191). Any copy
  ; changes the inode, so a byte-perfect, digest-verified copy still refuses to
  ; open: `fatal: Invalid device file, was modified`, forever. That guard is there
  ; on purpose, to catch stores moved or copied unsafely.
  ;
  ; THE LESSON, worth more than the code: verifying a migration by comparing
  ; digests proves THE BYTES ARRIVED. It does not prove THE STORE OPENS. Those are
  ; different claims and only the second one matters.
  ;
  ; So the service is simply pointed at %APPDATA%\peartune-desktop\data - the same
  ; directory the tray app uses. Nothing is copied, nothing is moved, and the
  ; device-file guard never has cause to fire. LocalSystem has access to a user
  ; profile, which is what makes this possible at all.
  ;
  ; DO NOT USE NSIS'S $APPDATA HERE. Under a perMachine install electron-builder
  ; sets SetShellVarContext all, which makes $APPDATA resolve to C:\ProgramData -
  ; NOT the user's roaming folder. That pointed the service at
  ; C:\ProgramData\peartune-desktop\data, where it happily created a BRAND NEW
  ; EMPTY LIBRARY and served it: running, healthy, zero tracks, zero devices, and
  ; the real library sitting untouched in the user's profile. Found on hardware
  ; 2026-08-01 - the same shape as the $%ProgramData% bug, and the same fix.
  ;
  ; %APPDATA% read from the ENVIRONMENT is the roaming folder of whoever launched
  ; the installer, which is the person whose library this is.
  ;
  ; This does tie a machine-wide service to one profile - the accepted trade
  ; (Tim, 2026-08-01) against copying a store that cannot be safely copied.
  ExpandEnvStrings $3 "%APPDATA%"
  StrCpy $2 "$3\peartune-desktop\data"

  ; $MUSIC IS THE SAME TRAP, third time: SetShellVarContext all makes it
  ; C:\Users\Public\Music rather than the person's own Music folder. It shipped
  ; that way once (2026-08-01) - harmless on a test box where both are empty, and
  ; wrong for anyone who keeps music where the tray app looks for it, which is
  ; exactly app.getPath('music') = %USERPROFILE%\Music. Service and tray must agree
  ; on the library's music folder or the two disagree about what is in it.
  ExpandEnvStrings $4 "%USERPROFILE%"
  StrCpy $5 "$4\Music"
  DetailPrint "The service will use the existing library at $2"

  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" install ${SVC_NAME} "$INSTDIR\PearTune.exe"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppParameters "\"$INSTDIR\resources\app.asar\vendor\host\index.js\""'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppDirectory "$INSTDIR"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} DisplayName "PearTune host"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} Description "Serves your PearTune music library so your phones can reach it, whether or not anyone is signed in."'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} Start SERVICE_AUTO_START'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} ObjectName LocalSystem'

  ; ELECTRON_RUN_AS_NODE is what makes the Electron binary behave as Node - no
  ; display needed, which is the whole reason a service is possible at all.
  ; PEARTUNE_DATA/MUSIC are passed as ENV because LocalSystem has no user profile:
  ; %USERPROFILE% inside the service is the SYSTEM profile, not the person's, so
  ; the host would otherwise look for music in the wrong place entirely.
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppEnvironmentExtra "ELECTRON_RUN_AS_NODE=1" "PEARTUNE_DATA=$2" "PEARTUNE_MUSIC=$5"'

  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppStdout "$1\PearTune\service.log"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppStderr "$1\PearTune\service.log"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppRotateFiles 1'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppRotateBytes 1048576'

  ; Come back from a crash without a human. Restart/60s three times, counter resets
  ; daily - the seeder's values, and the point of being a service at all.
  nsExec::ExecToLog 'sc.exe failure ${SVC_NAME} reset= 86400 actions= restart/60000/restart/60000/restart/60000'

  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" start ${SVC_NAME}'
  DetailPrint "PearTune host service registered and started."

!macroend

!macro customUnInstall
  DetailPrint "Removing the PearTune host service..."
  ExpandEnvStrings $1 "%ProgramData%"
  ; Same trap as the install path: NSIS's own $APPDATA is C:\ProgramData here.
  ExpandEnvStrings $3 "%APPDATA%"
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" stop ${SVC_NAME}'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" remove ${SVC_NAME} confirm'
  nsExec::ExecToLog 'sc.exe stop ${SVC_NAME}'
  nsExec::ExecToLog 'sc.exe delete ${SVC_NAME}'

  ; THE LIBRARY IS NEVER TOUCHED. It lives in %APPDATA%\peartune-desktop\data and
  ; this installer never copied or moved it - the service was only ever POINTED at
  ; it. host.seed there is the identity every paired phone knows this library by,
  ; and store/ is the grant list; nothing regenerates either. Removing the service
  ; must not cost someone their library, so nothing here deletes anything but the
  ; service registration and the log directory it wrote.
  DetailPrint "Your library is untouched in $3\peartune-desktop\data"
!macroend
