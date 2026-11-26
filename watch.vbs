Option Explicit
Dim shell, fs, base, node, watcher
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
base = fs.GetParentFolderName(WScript.ScriptFullName)
node = fs.BuildPath(base, "runtime\node.exe")
watcher = fs.BuildPath(base, "src\codex-draft-watch.mjs")
shell.Run Chr(34) & node & Chr(34) & " " & Chr(34) & watcher & Chr(34), 0, False

