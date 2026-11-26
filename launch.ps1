$ErrorActionPreference = 'Stop'
try {
  $app = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
  if (-not $app) { throw '未找到官方 Codex 桌面版。' }
  $running = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.ExecutablePath -like '*\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe' -and $_.CommandLine -notmatch '--type=' })
  if ($running.Count -gt 0 -and -not ($running.CommandLine -match '--remote-debugging-port=\d+')) { throw 'Codex 已经运行，但没有启用本工具需要的本机调试接口。请先完全退出 Codex，再使用此快捷方式启动。' }
  $watch = Join-Path $PSScriptRoot 'src\codex-draft-watch.mjs'
  $watchers = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($watch) })
  if (-not $watchers.Count) { Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList @('//B','//NoLogo',('"' + (Join-Path $PSScriptRoot 'watch.vbs') + '"')) -WindowStyle Hidden }
  if ($running.Count) { Start-Process "shell:AppsFolder\$($app.PackageFamilyName)!App"; exit }
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}
public static class CodexActivator {
  public static void Launch(string id, string args) {
    uint pid; var manager=(IApplicationActivationManager)new ApplicationActivationManager();
    int result=manager.ActivateApplication(id,args,0,out pid);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
  }
}
'@
  [CodexActivator]::Launch("$($app.PackageFamilyName)!App", "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$port")
} catch { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($_.Exception.Message,'Codex Prompt Assistant') | Out-Null; exit 1 }

