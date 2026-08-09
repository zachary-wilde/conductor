; Conductor — custom NSIS uninstall step.
; Removes the per-user sign-in autostart the app writes (userland Run key,
; no admin elevation needed, matches the perMachine:false installer).
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ConductorCore"
!macroend
