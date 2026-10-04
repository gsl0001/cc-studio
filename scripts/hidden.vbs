' Runs "cc-studio.cmd <task>" with no console window and waits for it, so the Task
' Scheduler entry stays Running and gets the real exit code. (A visible console window
' that gets closed by accident takes the task down with it.)
'   wscript.exe scripts\hidden.vbs bot
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WScript.Quit sh.Run("cmd /c """ & here & "\..\cc-studio.cmd"" " & WScript.Arguments(0), 0, True)
