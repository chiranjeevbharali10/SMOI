# "Another app" for the desktop check: a plain maximized window in its own process, so the check
# never touches the user's own apps. Prints its window handle, then runs until killed.
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class D { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }
'@
[D]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$form = New-Object System.Windows.Forms.Form
$form.Text = 'SMOI desktop check target'
$form.BackColor = [System.Drawing.Color]::White
$form.WindowState = 'Maximized'
$form.Add_Shown({ [Console]::Out.WriteLine([int64]$form.Handle); [Console]::Out.Flush() })
[System.Windows.Forms.Application]::Run($form)
