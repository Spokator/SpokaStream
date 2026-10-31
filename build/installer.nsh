; Les liens d'invitation doivent marcher dès la fin de l'installation, avant même le premier lancement.
!macro customInstall
  WriteRegStr SHCTX "Software\Classes\spokastream" "" "URL:SpokaStream"
  WriteRegStr SHCTX "Software\Classes\spokastream" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\spokastream\DefaultIcon" "" "$INSTDIR\SpokaStream.exe,0"
  WriteRegStr SHCTX "Software\Classes\spokastream\shell\open\command" "" '"$INSTDIR\SpokaStream.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\spokastream"
!macroend
