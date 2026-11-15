param(
  [string]$Action = 'shot',   # shot | click | key | drag
  [int]$X = 0,
  [int]$Y = 0,
  [int]$X2 = 0,
  [int]$Y2 = 0,
  [string]$Name = 'capture',
  [string]$Key = '',
  [double]$Scale = 1.6
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing | Out-Null
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RefCap2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public struct POINT { public int X, Y; }
}
"@
$refDir = 'D:\逆向\plangirls-web\docs\reference'
New-Item -ItemType Directory -Force -Path $refDir | Out-Null

function Get-Hwnd { (Get-Process -Name Lawn -ErrorAction Stop).MainWindowHandle }
function Get-ClientOrigin($hwnd) {
  $pt = New-Object RefCap2+POINT
  [RefCap2]::ClientToScreen($hwnd, [ref]$pt) | Out-Null
  @($pt.X, $pt.Y)
}
function Focus-Game {
  $hwnd = Get-Hwnd
  [RefCap2]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 300
  $hwnd
}
function Click-Game([int]$lx, [int]$ly) {
  $hwnd = Focus-Game
  $o = Get-ClientOrigin $hwnd
  $sx = $o[0] + [int]($lx * $Scale)
  $sy = $o[1] + [int]($ly * $Scale)
  [RefCap2]::SetCursorPos($sx, $sy) | Out-Null
  Start-Sleep -Milliseconds 120
  [RefCap2]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 70
  [RefCap2]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  "clicked ($lx,$ly)"
}

function Shot([string]$name) {
  $hwnd = Get-Hwnd
  [RefCap2]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 450
  $r = New-Object RefCap2+RECT
  [RefCap2]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen((New-Object System.Drawing.Point $r.Left, $r.Top), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size $w, $h))
  $bmp.Save((Join-Path $refDir "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  "saved $name.png ($w x $h)"
}

switch ($Action) {
  'click' {
    Click-Game $X $Y
    Start-Sleep -Milliseconds 1200
    Shot $Name
  }
  'move' {
    $hwnd = Focus-Game
    $o = Get-ClientOrigin $hwnd
    [RefCap2]::SetCursorPos($o[0] + [int]($X * $Scale), $o[1] + [int]($Y * $Scale)) | Out-Null
    Start-Sleep -Milliseconds 700
    Shot $Name
  }
  'drag' {
    $hwnd = Focus-Game
    $o = Get-ClientOrigin $hwnd
    $sx = $o[0] + [int]($X * $Scale); $sy = $o[1] + [int]($Y * $Scale)
    $ex = $o[0] + [int]($X2 * $Scale); $ey = $o[1] + [int]($Y2 * $Scale)
    [RefCap2]::SetCursorPos($sx, $sy) | Out-Null
    Start-Sleep -Milliseconds 120
    [RefCap2]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    [RefCap2]::mouse_event(0x0001, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    [RefCap2]::SetCursorPos($ex, $ey) | Out-Null
    Start-Sleep -Milliseconds 120
    [RefCap2]::mouse_event(0x0001, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    [RefCap2]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 900
    Shot $Name
  }
  'key' {
    $hwnd = Focus-Game
    if ($Key -eq 'space') { [RefCap2]::keybd_event(0x20, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 80; [RefCap2]::keybd_event(0x20, 0, 2, [IntPtr]::Zero) }
    elseif ($Key -eq 'esc') { [RefCap2]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 80; [RefCap2]::keybd_event(0x1B, 0, 2, [IntPtr]::Zero) }
    elseif ($Key -eq 'enter') { [RefCap2]::keybd_event(0x0D, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 80; [RefCap2]::keybd_event(0x0D, 0, 2, [IntPtr]::Zero) }
    Start-Sleep -Milliseconds 900
    Shot $Name
  }
  default { Shot $Name }
}
