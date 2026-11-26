param([string]$InstallPath = "$env:LOCALAPPDATA\CodexPromptAssistant", [switch]$TestMode)
$ErrorActionPreference = 'Stop'
try {
  $source = $PSScriptRoot
  if ([IO.Path]::GetFullPath($source).TrimEnd('\') -eq [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')) { throw 'Please run the installer from the extracted download folder.' }
  if (-not (Get-AppxPackage -Name OpenAI.Codex)) { throw 'Official Codex desktop app was not found. Install Codex first.' }
  foreach ($f in @('runtime\node.exe','runtime\NODE-LICENSE.txt','src\codex-draft-button.mjs','src\codex-draft-rewrite.mjs','src\codex-draft-watch.mjs','launch.ps1','watch.vbs','launch.vbs','uninstall.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $f) -PathType Leaf)) { throw "Missing file: $f" }
  }
  $owned = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -eq (Join-Path $InstallPath 'runtime\node.exe') })
  if ($owned.Count) { throw 'The installed assistant is running. Exit its processes before updating; existing files were not changed.' }
  $items = @('runtime','src','launch.ps1','watch.vbs','launch.vbs','uninstall.ps1','diagnose.ps1','README.md')
  $backup = Join-Path ([IO.Path]::GetTempPath()) ('codex-prompt-backup-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $InstallPath,$backup -Force | Out-Null
  $saved = @(); $created = @(); $keepBackup = $false
  try {
    foreach ($f in $items) {
      $target = Join-Path $InstallPath $f
      if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination $backup -Recurse -Force; $saved += $f }
      else { $created += $f }
      $incoming = Join-Path $source $f
      if ((Test-Path -LiteralPath $incoming -PathType Container) -and (Test-Path -LiteralPath $target -PathType Container)) {
        Get-ChildItem -LiteralPath $incoming -Force | Copy-Item -Destination $target -Recurse -Force
      } else { Copy-Item -LiteralPath $incoming -Destination $InstallPath -Recurse -Force }
    }
  } catch {
    try {
    foreach ($f in $created) { $target = Join-Path $InstallPath $f; if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force } }
    foreach ($f in $saved) { $target = Join-Path $InstallPath $f; if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }; Copy-Item -LiteralPath (Join-Path $backup $f) -Destination $InstallPath -Recurse -Force }
    } catch { $keepBackup = $true; throw "Rollback failed; backup retained at $backup. $($_.Exception.Message)" }
    throw
  } finally { if (-not $keepBackup) { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue } }
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
    $shortcut = $shell.CreateShortcut((Join-Path $programs 'Check Prompt Assistant.lnk'))
    $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallPath 'diagnose.ps1') + '"'
    $shortcut.WorkingDirectory = $InstallPath
    $shortcut.Save()
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

