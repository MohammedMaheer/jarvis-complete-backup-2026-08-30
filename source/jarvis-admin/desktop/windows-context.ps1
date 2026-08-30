[CmdletBinding()]
param(
  [ValidateRange(10, 250)]
  [int]$MaxElements = 160
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

if (-not ('JarvisDesktopNative' -as [type])) {
  Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class JarvisDesktopNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT point);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  public static string WindowText(IntPtr hWnd) {
    var buffer = new StringBuilder(512);
    GetWindowText(hWnd, buffer, buffer.Capacity);
    return buffer.ToString();
  }

  public static uint ProcessId(IntPtr hWnd) {
    uint processId;
    GetWindowThreadProcessId(hWnd, out processId);
    return processId;
  }
}
'@
}

function Limit-Text([string]$Value, [int]$Limit = 240) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  $clean = ($Value -replace '[\x00-\x1F]+', ' ' -replace '\s+', ' ').Trim()
  if ($clean.Length -le $Limit) { return $clean }
  return $clean.Substring(0, $Limit)
}

function Test-ExcludedContext([string]$ProcessName, [string]$Title) {
  $excludedProcesses = @('1password', 'bitwarden', 'keepass', 'keepassxc', 'dashlane', 'enpass', 'lastpass')
  if ($excludedProcesses -contains ([string]$ProcessName).ToLowerInvariant()) { return $true }
  return [bool]($Title -match '(?i)\b(incognito|inprivate|private browsing|password manager|windows security|credential manager)\b')
}

$foregroundHandle = [JarvisDesktopNative]::GetForegroundWindow()
$foregroundPid = [int][JarvisDesktopNative]::ProcessId($foregroundHandle)
$foregroundProcess = Get-Process -Id $foregroundPid -ErrorAction SilentlyContinue
$foregroundTitle = Limit-Text ([JarvisDesktopNative]::WindowText($foregroundHandle)) 300
$foregroundProcessName = if ($foregroundProcess) { $foregroundProcess.ProcessName } else { '' }
$contextExcluded = Test-ExcludedContext $foregroundProcessName $foregroundTitle

$cursorPoint = New-Object JarvisDesktopNative+POINT
[void][JarvisDesktopNative]::GetCursorPos([ref]$cursorPoint)

$windows = [System.Collections.Generic.List[object]]::new()
$windowCallback = [JarvisDesktopNative+EnumWindowsProc]{
  param([IntPtr]$Handle, [IntPtr]$State)
  if (-not [JarvisDesktopNative]::IsWindowVisible($Handle)) { return $true }
  $title = Limit-Text ([JarvisDesktopNative]::WindowText($Handle)) 220
  if (-not $title) { return $true }
  $processId = [int][JarvisDesktopNative]::ProcessId($Handle)
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  $processName = if ($process) { $process.ProcessName } else { '' }
  $windowExcluded = Test-ExcludedContext $processName $title
  $rect = New-Object JarvisDesktopNative+RECT
  [void][JarvisDesktopNative]::GetWindowRect($Handle, [ref]$rect)
  $windows.Add([pscustomobject]@{
    title = if ($windowExcluded) { '[private window excluded]' } else { $title }
    processName = $processName
    processId = $processId
    isForeground = ($Handle -eq $foregroundHandle)
    bounds = [pscustomobject]@{
      x = $rect.Left
      y = $rect.Top
      width = [Math]::Max(0, $rect.Right - $rect.Left)
      height = [Math]::Max(0, $rect.Bottom - $rect.Top)
    }
  })
  return ($windows.Count -lt 40)
}
[void][JarvisDesktopNative]::EnumWindows($windowCallback, [IntPtr]::Zero)

$elements = [System.Collections.Generic.List[object]]::new()
$accessibilityAvailable = $false
if ($foregroundHandle -ne [IntPtr]::Zero -and -not $contextExcluded) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($foregroundHandle)
    if ($root) {
      $accessibilityAvailable = $true
      $all = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      for ($index = 0; $index -lt $all.Count -and $elements.Count -lt $MaxElements; $index++) {
        try {
          $element = $all.Item($index)
          $current = $element.Current
          if ($current.IsOffscreen) { continue }
          $name = Limit-Text $current.Name 180
          $automationId = Limit-Text $current.AutomationId 120
          if (-not $name -and -not $automationId) { continue }
          $rectangle = $current.BoundingRectangle
          if ($rectangle.IsEmpty -or $rectangle.Width -le 0 -or $rectangle.Height -le 0) { continue }
          $controlType = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
          $clickable = $controlType -in @('Button', 'Hyperlink', 'MenuItem', 'TabItem', 'CheckBox', 'RadioButton', 'ListItem', 'TreeItem')
          $elements.Add([pscustomobject]@{
            name = $name
            controlType = $controlType
            automationId = $automationId
            className = Limit-Text $current.ClassName 100
            enabled = [bool]$current.IsEnabled
            clickable = $clickable
            bounds = [pscustomobject]@{
              x = [Math]::Round($rectangle.X)
              y = [Math]::Round($rectangle.Y)
              width = [Math]::Round($rectangle.Width)
              height = [Math]::Round($rectangle.Height)
            }
          })
        } catch {
          continue
        }
      }
    }
  } catch {
    $accessibilityAvailable = $false
  }
}

[pscustomobject]@{
  capturedAt = [DateTimeOffset]::Now.ToString('o')
  foreground = [pscustomobject]@{
    title = if ($contextExcluded) { '[private window excluded]' } else { $foregroundTitle }
    processName = $foregroundProcessName
    processId = $foregroundPid
  }
  cursor = [pscustomobject]@{ x = $cursorPoint.X; y = $cursorPoint.Y }
  accessibilityAvailable = $accessibilityAvailable
  screenAccess = if ($contextExcluded) { 'blocked' } else { 'on_demand' }
  exclusionReason = if ($contextExcluded) { 'The active application or window matches the local screen exclusion policy.' } else { $null }
  windows = @($windows)
  elements = @($elements)
} | ConvertTo-Json -Depth 7 -Compress
