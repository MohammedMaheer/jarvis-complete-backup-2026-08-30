$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartScript = Join-Path $ScriptDir 'start-jarvis.ps1'
$StartupDir = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupDir 'Jarvis Assistant.lnk'
$PowerShellPath = (Get-Command powershell.exe).Source

if (-not (Test-Path -LiteralPath $StartScript)) {
    throw "Jarvis start script not found: $StartScript"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $PowerShellPath
$shortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`""
$shortcut.WorkingDirectory = $ScriptDir
$shortcut.Description = 'Start Jarvis and open its command UI at Windows sign-in'
$shortcut.Save()

Write-Host "Jarvis auto-start installed: $ShortcutPath" -ForegroundColor Green
