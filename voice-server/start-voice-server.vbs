' start-voice-server.vbs — launches the local Kokoro TTS server hidden.
' Drop a shortcut into shell:startup to run it at login (same pattern as
' the agentic-os runner).

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' Push-to-talk only — wake word stays off (no bundled wake model, and
' speaker bleed into the mic would clash with HELM's own replies).
WshShell.Environment("PROCESS")("WAKE_WORD") = "off"

WshShell.Run """" & dir & "\.venv\Scripts\python.exe"" """ & dir & "\server.py""", 0, False
Set WshShell = Nothing
