param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('window_control', 'process_snapshot')]
    [string]$Action,
    [string]$Query = '',
    [ValidateSet('focus', 'minimize', 'maximize', 'restore', 'snap_left', 'snap_right', 'move_monitor')]
    [string]$Operation = 'focus',
    [ValidateRange(1, 16)]
    [int]$Monitor = 1
)

$ErrorActionPreference = 'Stop'

function Write-Result([hashtable]$Value) {
    $Value | ConvertTo-Json -Depth 6 -Compress
}

if ($Action -eq 'process_snapshot') {
    $rows = Get-Process | Where-Object { $_.Id -ne $PID -and $_.ProcessName } |
        Sort-Object WorkingSet64 -Descending | Select-Object -First 8 |
        ForEach-Object {
            [ordered]@{
                name = $_.ProcessName
                processId = $_.Id
                memoryMb = [math]::Round($_.WorkingSet64 / 1MB, 1)
                hasWindow = $_.MainWindowHandle -ne 0
                title = if ($_.MainWindowTitle) { $_.MainWindowTitle.Substring(0, [math]::Min(120, $_.MainWindowTitle.Length)) } else { '' }
            }
        }
    Write-Result @{ success = $true; operation = 'process_snapshot'; verified = $true; processes = @($rows) }
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JarvisWindowApi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
}
'@

$needle = $Query.Trim().ToLowerInvariant()
if (-not $needle) { throw 'A window name is required.' }
$aliases = @{
    'browser' = @('chrome', 'msedge', 'firefox')
    'chrome' = @('chrome')
    'edge' = @('msedge')
    'vscode' = @('code')
    'vs code' = @('code')
    'spotify' = @('spotify')
    'terminal' = @('windowsterminal', 'powershell', 'pwsh')
}
$candidateNames = if ($aliases.ContainsKey($needle)) { $aliases[$needle] } else { @($needle.Replace(' ', '')) }
$window = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and (
        $candidateNames -contains $_.ProcessName.ToLowerInvariant() -or
        $_.ProcessName.ToLowerInvariant().Contains($needle.Replace(' ', '')) -or
        $_.MainWindowTitle.ToLowerInvariant().Contains($needle)
    )
} | Sort-Object StartTime -Descending | Select-Object -First 1

if (-not $window) { throw "No visible window matched '$Query'." }
$handle = [IntPtr]$window.MainWindowHandle
$screens = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object { if ($_.Primary) { 0 } else { 1 } }, DeviceName)
$currentScreen = [System.Windows.Forms.Screen]::FromHandle($handle)
$targetArea = $currentScreen.WorkingArea
$expectedArea = $null
$shell = New-Object -ComObject WScript.Shell

switch ($Operation) {
    'focus' { [void][JarvisWindowApi]::ShowWindowAsync($handle, 9); [void]$shell.AppActivate($window.Id); [void][JarvisWindowApi]::SetForegroundWindow($handle) }
    'minimize' { [void][JarvisWindowApi]::ShowWindowAsync($handle, 6) }
    'maximize' { [void][JarvisWindowApi]::ShowWindowAsync($handle, 3) }
    'restore' { [void][JarvisWindowApi]::ShowWindowAsync($handle, 9); [void]$shell.AppActivate($window.Id); [void][JarvisWindowApi]::SetForegroundWindow($handle) }
    'snap_left' {
        $expectedArea = @{ x = $targetArea.X; y = $targetArea.Y; width = [int]($targetArea.Width / 2); height = $targetArea.Height }
        [void][JarvisWindowApi]::ShowWindowAsync($handle, 9)
        [void][JarvisWindowApi]::SetWindowPos($handle, [IntPtr]::Zero, $targetArea.X, $targetArea.Y, [int]($targetArea.Width / 2), $targetArea.Height, 0x0040)
    }
    'snap_right' {
        $expectedArea = @{ x = $targetArea.X + [int]($targetArea.Width / 2); y = $targetArea.Y; width = [int]($targetArea.Width / 2); height = $targetArea.Height }
        [void][JarvisWindowApi]::ShowWindowAsync($handle, 9)
        [void][JarvisWindowApi]::SetWindowPos($handle, [IntPtr]::Zero, $targetArea.X + [int]($targetArea.Width / 2), $targetArea.Y, [int]($targetArea.Width / 2), $targetArea.Height, 0x0040)
    }
    'move_monitor' {
        if ($Monitor -gt $screens.Count) { throw "Monitor $Monitor is unavailable; $($screens.Count) monitor(s) detected." }
        $destination = $screens[$Monitor - 1].WorkingArea
        $expectedArea = @{ x = $destination.X + 24; y = $destination.Y + 24; width = [math]::Max(640, $destination.Width - 48); height = [math]::Max(480, $destination.Height - 48) }
        [void][JarvisWindowApi]::ShowWindowAsync($handle, 9)
        [void][JarvisWindowApi]::SetWindowPos($handle, [IntPtr]::Zero, $destination.X + 24, $destination.Y + 24, [math]::Max(640, $destination.Width - 48), [math]::Max(480, $destination.Height - 48), 0x0040)
    }
}

Start-Sleep -Milliseconds 180
$rect = New-Object JarvisWindowApi+RECT
$rectAvailable = [JarvisWindowApi]::GetWindowRect($handle, [ref]$rect)
$bounds = @{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
$verified = switch ($Operation) {
    'focus' { [JarvisWindowApi]::GetForegroundWindow() -eq $handle }
    'minimize' { [JarvisWindowApi]::IsIconic($handle) }
    'maximize' { [JarvisWindowApi]::IsZoomed($handle) }
    'restore' { $rectAvailable -and -not [JarvisWindowApi]::IsIconic($handle) }
    default {
        $rectAvailable -and $null -ne $expectedArea -and
        [math]::Abs($bounds.x - $expectedArea.x) -le 8 -and
        [math]::Abs($bounds.y - $expectedArea.y) -le 8 -and
        [math]::Abs($bounds.width - $expectedArea.width) -le 16 -and
        [math]::Abs($bounds.height - $expectedArea.height) -le 16
    }
}
Write-Result @{
    success = [bool]$verified
    operation = $Operation
    verified = [bool]$verified
    target = $window.ProcessName
    processId = $window.Id
    title = $window.MainWindowTitle.Substring(0, [math]::Min(120, $window.MainWindowTitle.Length))
    bounds = $bounds
    monitorCount = $screens.Count
}
