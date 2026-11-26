param([string]$InstallPath = "$env:LOCALAPPDATA\CodexPromptAssistant", [switch]$TestMode)
$ErrorActionPreference = 'Stop'
try {
  $source = $PSScriptRoot
  if ([IO.Path]::GetFullPath($source).TrimEnd('\') -eq [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')) { throw 'Please run the installer from the extracted download folder.' }
  if (-not (Get-AppxPackage -Name OpenAI.Codex)) { throw 'Official Codex desktop app was not found. Install Codex first.' }
  foreach ($f in @('runtime\node.exe','runtime\NODE-LICENSE.txt','src\codex-draft-button.mjs','src\codex-draft-rewrite.mjs','src\codex-draft-watch.mjs','launch.ps1','watch.vbs','launch.vbs','uninstall.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $f) -PathType Leaf)) { throw "Missing file: $f" }
  }
  New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $source 'runtime'),(Join-Path $source 'src') -Destination $InstallPath -Recurse -Force
  foreach ($f in @('launch.ps1','watch.vbs','launch.vbs','uninstall.ps1','README.md')) { Copy-Item -LiteralPath (Join-Path $source $f) -Destination $InstallPath -Force }
  if (-not $TestMode) {
    $shell = New-Object -ComObject WScript.Shell
    $startup = [Environment]::GetFolderPath('Startup')
    $shortcut = $shell.CreateShortcut((Join-Path $startup 'Codex Prompt Assistant.lnk'))
    $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
    $shortcut.Arguments = '//B //NoLogo "' + (Join-Path $InstallPath 'watch.vbs') + '"'
    $shortcut.WorkingDirectory = $InstallPath
    $shortcut.Save()
    $programs = Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Prompt Assistant'
    New-Item -ItemType Directory -Path $programs -Force | Out-Null
    $shortcut = $shell.CreateShortcut((Join-Path $programs 'Start Codex with Prompt Assistant.lnk'))
    $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
    $shortcut.Arguments = '//B //NoLogo "' + (Join-Path $InstallPath 'launch.vbs') + '"'
    $shortcut.WorkingDirectory = $InstallPath
    $shortcut.Save()
    $shortcut = $shell.CreateShortcut((Join-Path $programs 'Uninstall Prompt Assistant.lnk'))
    $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallPath 'uninstall.ps1') + '"'
    $shortcut.WorkingDirectory = $env:TEMP
    $shortcut.Save()
    Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList @('//B','//NoLogo',('"' + (Join-Path $InstallPath 'watch.vbs') + '"')) -WindowStyle Hidden
  }
  Write-Host "Installed to: $InstallPath"
  if (-not (Get-Command ollama.exe -ErrorAction SilentlyContinue)) { Write-Host 'Install Ollama and run: ollama pull qwen3.5:4b' }
  else { $models = & ollama list 2>$null; if ($LASTEXITCODE -ne 0 -or -not ($models -match '^qwen3\.5:4b\s')) { Write-Host 'Start Ollama and run: ollama pull qwen3.5:4b' } }
  if (-not $TestMode) { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('安装完成。请从开始菜单运行 Start Codex with Prompt Assistant。若 Codex 已在运行且按钮未显示，请先退出 Codex 后使用该入口。请确保 Ollama 已安装 qwen3.5:4b。','Codex Prompt Assistant') | Out-Null }
} catch { [Console]::Error.WriteLine($_.Exception.Message); if (-not $TestMode) { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($_.Exception.Message,'Installation failed') | Out-Null }; exit 1 }

