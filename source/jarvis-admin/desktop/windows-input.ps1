[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('cursor_move', 'cursor_click', 'click_element', 'type_text', 'key_press')]
  [string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [ValidateSet('left', 'right')]
  [string]$Button = 'left',
  [ValidateRange(1, 2)]
  [int]$Clicks = 1,
  [string]$Text = '',
  [string]$Key = '',
  [string]$Query = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ('JarvisDesktopInput' -as [type])) {
  Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class JarvisDesktopInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern uint SendInput(uint count, INPUT[] inputs, int size);

  private const uint INPUT_MOUSE = 0;
  private const uint INPUT_KEYBOARD = 1;
  private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  private const uint MOUSEEVENTF_LEFTUP = 0x0004;
  private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  private const uint KEYEVENTF_KEYUP = 0x0002;
  private const uint KEYEVENTF_UNICODE = 0x0004;

  public static void Click(bool right, int clicks) {
    uint down = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
    uint up = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
    for (int index = 0; index < clicks; index++) {
      var inputs = new [] {
        new INPUT { type = INPUT_MOUSE, U = new InputUnion { mi = new MOUSEINPUT { dwFlags = down } } },
        new INPUT { type = INPUT_MOUSE, U = new InputUnion { mi = new MOUSEINPUT { dwFlags = up } } },
      };
      if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != (uint)inputs.Length) {
        throw new InvalidOperationException("Windows rejected the mouse input event.");
      }
      if (clicks > 1) Thread.Sleep(80);
    }
  }

  public static void TypeUnicode(string value) {
    var inputs = new List<INPUT>();
    foreach (char character in value) {
      inputs.Add(new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wScan = character, dwFlags = KEYEVENTF_UNICODE } } });
      inputs.Add(new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wScan = character, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } });
    }
    if (inputs.Count > 0 && SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT))) != (uint)inputs.Count) {
      throw new InvalidOperationException("Windows rejected the keyboard input event.");
    }
  }
}
'@
}

function Assert-Coordinate([int]$CoordinateX, [int]$CoordinateY) {
  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($CoordinateX -lt $virtual.Left -or $CoordinateX -ge $virtual.Right -or $CoordinateY -lt $virtual.Top -or $CoordinateY -ge $virtual.Bottom) {
    throw "Cursor coordinates are outside the active desktop bounds."
  }
}

function Find-AccessibleElement([string]$NameQuery) {
  if ([string]::IsNullOrWhiteSpace($NameQuery) -or $NameQuery.Length -gt 120) {
    throw 'The accessible element query must contain 1-120 characters.'
  }
  $root = [System.Windows.Automation.AutomationElement]::FocusedElement
  if (-not $root) { throw 'No foreground application is available.' }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  while ($root -and $root.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
    $parent = $walker.GetParent($root)
    if (-not $parent) { break }
    $root = $parent
  }
  if (-not $root) { $root = [System.Windows.Automation.AutomationElement]::RootElement }
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $needle = $NameQuery.Trim()
  $containsMatch = $null
  for ($index = 0; $index -lt $all.Count -and $index -lt 2000; $index++) {
    try {
      $candidate = $all.Item($index)
      $name = $candidate.Current.Name
      if (-not $candidate.Current.IsEnabled -or $candidate.Current.IsOffscreen -or [string]::IsNullOrWhiteSpace($name)) { continue }
      if ($name.Equals($needle, [StringComparison]::OrdinalIgnoreCase)) { return $candidate }
      if (-not $containsMatch -and $name.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $containsMatch = $candidate }
    } catch {
      continue
    }
  }
  return $containsMatch
}

$message = ''
$evidence = [ordered]@{ action = $Action }
switch ($Action) {
  'cursor_move' {
    Assert-Coordinate $X $Y
    if (-not [JarvisDesktopInput]::SetCursorPos($X, $Y)) { throw 'Windows rejected the cursor position.' }
    $message = "Moved the cursor to $X, $Y."
    $evidence.x = $X
    $evidence.y = $Y
  }
  'cursor_click' {
    Assert-Coordinate $X $Y
    if (-not [JarvisDesktopInput]::SetCursorPos($X, $Y)) { throw 'Windows rejected the cursor position.' }
    Start-Sleep -Milliseconds 80
    [JarvisDesktopInput]::Click(($Button -eq 'right'), $Clicks)
    $message = "Completed a $Button click at $X, $Y."
    $evidence.x = $X
    $evidence.y = $Y
    $evidence.button = $Button
    $evidence.clicks = $Clicks
  }
  'click_element' {
    $element = Find-AccessibleElement $Query
    if (-not $element) { throw "No visible accessible element matched '$Query'." }
    $rectangle = $element.Current.BoundingRectangle
    if ($rectangle.IsEmpty -or $rectangle.Width -le 0 -or $rectangle.Height -le 0) { throw 'The matched element has no clickable screen bounds.' }
    $targetX = [int][Math]::Round($rectangle.X + ($rectangle.Width / 2))
    $targetY = [int][Math]::Round($rectangle.Y + ($rectangle.Height / 2))
    Assert-Coordinate $targetX $targetY
    if (-not [JarvisDesktopInput]::SetCursorPos($targetX, $targetY)) { throw 'Windows rejected the cursor position.' }
    Start-Sleep -Milliseconds 80
    [JarvisDesktopInput]::Click($false, 1)
    $message = "Clicked '$($element.Current.Name)'."
    $evidence.query = $Query
    $evidence.matched = $element.Current.Name
    $evidence.x = $targetX
    $evidence.y = $targetY
  }
  'type_text' {
    if ([string]::IsNullOrEmpty($Text) -or $Text.Length -gt 500) { throw 'Text input must contain 1-500 characters.' }
    [JarvisDesktopInput]::TypeUnicode($Text)
    $message = "Typed $($Text.Length) characters into the focused control."
    $evidence.characterCount = $Text.Length
  }
  'key_press' {
    $allowedKeys = @('ENTER', 'TAB', 'ESCAPE', 'BACKSPACE', 'DELETE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN', 'CTRL+A', 'CTRL+C', 'CTRL+V', 'CTRL+F', 'CTRL+L', 'CTRL+S', 'ALT+TAB')
    $normalizedKey = $Key.Trim().ToUpperInvariant()
    if ($normalizedKey -notin $allowedKeys) { throw 'The requested key is outside the local key allowlist.' }
    $sendKeys = @{
      'ENTER' = '{ENTER}'; 'TAB' = '{TAB}'; 'ESCAPE' = '{ESC}'; 'BACKSPACE' = '{BACKSPACE}'; 'DELETE' = '{DELETE}'
      'UP' = '{UP}'; 'DOWN' = '{DOWN}'; 'LEFT' = '{LEFT}'; 'RIGHT' = '{RIGHT}'; 'HOME' = '{HOME}'; 'END' = '{END}'
      'PAGEUP' = '{PGUP}'; 'PAGEDOWN' = '{PGDN}'; 'CTRL+A' = '^a'; 'CTRL+C' = '^c'; 'CTRL+V' = '^v'; 'CTRL+F' = '^f'
      'CTRL+L' = '^l'; 'CTRL+S' = '^s'; 'ALT+TAB' = '%{TAB}'
    }
    [System.Windows.Forms.SendKeys]::SendWait($sendKeys[$normalizedKey])
    $message = "Pressed $normalizedKey."
    $evidence.key = $normalizedKey
  }
}

[pscustomobject]@{ success = $true; message = $message; evidence = $evidence } | ConvertTo-Json -Depth 5 -Compress
