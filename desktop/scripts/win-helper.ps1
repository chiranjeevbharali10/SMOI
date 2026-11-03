# Windows helper for scripts/desktop-check.ts. Reads one command per line on stdin and answers
# one line on stdout. It sends real mouse and keyboard input (SendInput), reads the foreground
# window, and captures screen pixels, so the desktop check exercises SMOI the way a person does.
#
# Commands (coordinates are physical screen pixels):
#   fg                      -> hwnd of the foreground window
#   click X Y               -> left click at X,Y
#   key NAME                -> press and release a key: esc, enter, down, up, tab
#   type TEXT               -> type TEXT (Unicode)
#   capture X Y W H PATH    -> save that screen rectangle as PNG
#   activate HWND           -> bring a window to the foreground
#   window NAME             -> hwnd of the main window of a running process called NAME, or 0
#   maximize HWND           -> maximize a window
#   quit
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static void Mouse(uint flags) { var i = new INPUT[1]; i[0].type = 0; i[0].mi.flags = flags; SendInput(1, i, Marshal.SizeOf(typeof(INPUT))); }
  // A real pointer move (SendInput), which apps see exactly like a mouse moving; SetCursorPos isn't.
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  public static void MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    var i = new INPUT[1]; i[0].type = 0;
    i[0].mi.dx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
    i[0].mi.dy = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
    i[0].mi.flags = 0x0001 | 0x8000 | 0x4000; // MOVE | ABSOLUTE | VIRTUALDESK
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Key(ushort vk, ushort scan, uint flags) { var i = new INPUT[1]; i[0].type = 1; i[0].ki.vk = vk; i[0].ki.scan = scan; i[0].ki.flags = flags; SendInput(1, i, Marshal.SizeOf(typeof(INPUT))); }
}
'@
# Per-monitor DPI aware, so coordinates are physical pixels on every display.
[W]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

$keys = @{ esc = 0x1B; enter = 0x0D; down = 0x28; up = 0x26; tab = 0x09 }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  $parts = $line.Split(' ', 2)
  $arg = if ($parts.Length -gt 1) { $parts[1] } else { '' }
  try {
    switch ($parts[0]) {
      'fg' { [Console]::Out.WriteLine([int64][W]::GetAncestor([W]::GetForegroundWindow(), 2)) }
      'click' {
        $xy = $arg.Split(' ')
        [W]::MoveTo([int]$xy[0], [int]$xy[1])
        Start-Sleep -Milliseconds 60
        [W]::Mouse(0x0002); Start-Sleep -Milliseconds 40; [W]::Mouse(0x0004)
        [Console]::Out.WriteLine('ok')
      }
      'move' {
        $xy = $arg.Split(' ')
        [W]::MoveTo([int]$xy[0], [int]$xy[1])
        [Console]::Out.WriteLine('ok')
      }
      'key' {
        $vk = [uint16]$keys[$arg]
        [W]::Key($vk, 0, 0); Start-Sleep -Milliseconds 30; [W]::Key($vk, 0, 2)
        [Console]::Out.WriteLine('ok')
      }
      'type' {
        foreach ($ch in $arg.ToCharArray()) {
          [W]::Key(0, [uint16]$ch, 4); [W]::Key(0, [uint16]$ch, 6)
          Start-Sleep -Milliseconds 8
        }
        [Console]::Out.WriteLine('ok')
      }
      'capture' {
        $a = $arg.Split(' ', 5)
        $bmp = New-Object System.Drawing.Bitmap([int]$a[2], [int]$a[3])
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen([int]$a[0], [int]$a[1], 0, 0, $bmp.Size)
        $bmp.Save($a[4], [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        [Console]::Out.WriteLine('ok')
      }
      'activate' {
        # Windows only lets the process with the last input take the foreground; a tap of Alt counts.
        [W]::Key(0x12, 0, 0); [W]::Key(0x12, 0, 2)
        [W]::SetForegroundWindow([IntPtr][int64]$arg) | Out-Null
        [Console]::Out.WriteLine('ok')
      }
      'window' {
        $p = Get-Process -Name $arg -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        [Console]::Out.WriteLine($(if ($p) { [int64]$p.MainWindowHandle } else { 0 }))
      }
      'maximize' {
        [W]::ShowWindow([IntPtr][int64]$arg, 3) | Out-Null
        [Console]::Out.WriteLine('ok')
      }
      default { [Console]::Out.WriteLine("error unknown command $($parts[0])") }
    }
  } catch {
    [Console]::Out.WriteLine("error $($_.Exception.Message)")
  }
}
