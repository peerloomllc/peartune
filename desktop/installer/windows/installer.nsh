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

  ; MIGRATE BEFORE THE SERVICE EVER STARTS. host.seed is the library's identity and
  ; store/ is the grant list; a LocalSystem service started against an empty
  ; ProgramData directory comes up healthy AS A DIFFERENT LIBRARY and every paired
  ; phone silently stops recognising it. migrate-data.js verifies every file by
  ; digest, never deletes the source, and leaves an already-migrated destination
  ; alone - so this is safe to run on every upgrade, which is what happens here.
  ;
  ; Run through the installed Electron binary in Node mode: there is no guarantee
  ; node.exe exists on the target machine, and we already ship a Node.
  DetailPrint "Migrating the library to ProgramData (identity is verified)..."
  nsExec::ExecToLog '"$INSTDIR\PearTune.exe" "$INSTDIR\resources\migrate-data.js"'
  Pop $0
  ${If} $0 != 0
    ; Non-zero means the copy did not verify. Do NOT register a service pointing at
    ; a half-migrated directory - that is precisely how a library gets orphaned.
    DetailPrint "Library migration FAILED to verify - not starting the service."
    MessageBox MB_ICONEXCLAMATION "PearTune could not safely move your library to a shared location, so the background service was not started.$\n$\nYour existing library has NOT been changed. PearTune still works from the tray."
    Goto skip_service
  ${EndIf}

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
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppEnvironmentExtra "ELECTRON_RUN_AS_NODE=1" "PEARTUNE_DATA=$1\PearTune\data" "PEARTUNE_MUSIC=$MUSIC"'

  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppStdout "$1\PearTune\service.log"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppStderr "$1\PearTune\service.log"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppRotateFiles 1'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SVC_NAME} AppRotateBytes 1048576'

  ; Come back from a crash without a human. Restart/60s three times, counter resets
  ; daily - the seeder's values, and the point of being a service at all.
  nsExec::ExecToLog 'sc.exe failure ${SVC_NAME} reset= 86400 actions= restart/60000/restart/60000/restart/60000'

  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" start ${SVC_NAME}'
  DetailPrint "PearTune host service registered and started."

  skip_service:
!macroend

!macro customUnInstall
  DetailPrint "Removing the PearTune host service..."
  ExpandEnvStrings $1 "%ProgramData%"
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" stop ${SVC_NAME}'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" remove ${SVC_NAME} confirm'
  nsExec::ExecToLog 'sc.exe stop ${SVC_NAME}'
  nsExec::ExecToLog 'sc.exe delete ${SVC_NAME}'

  ; THE LIBRARY IS NEVER DELETED. %ProgramData%\PearTune\data holds host.seed - the
  ; identity every paired phone knows this library by - and store/, the grant list.
  ; Nothing regenerates either, so uninstalling PearTune must not cost someone
  ; their library and all their pairings. Leaving a few MB behind is the right
  ; trade every time.
  DetailPrint "Your library has been left in $1\PearTune\data"
!macroend
