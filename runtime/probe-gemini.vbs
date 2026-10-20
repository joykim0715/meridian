Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node"
code = sh.Run("""" & node & """ """ & root & "\runtime\daily-gemini.js""", 7, True)
WScript.Quit code
