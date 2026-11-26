param([string]$InstallPath = $PSScriptRoot, [switch]$TestMode)
$ErrorActionPreference = 'Stop'
try {
  $full = [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')
  if (-not (Test-Path -LiteralPath (Join-Path $full 'src\codex-draft-watch.mjs'))) { throw 'Installation marker missing; no files removed.' }
  if (-not $TestMode) {
    $owned = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -eq (Join-Path $full 'runtime\node.exe') -and $_.CommandLine -and $_.CommandLine.Contains($full) })
    foreach ($process in $owned) { Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue }
    $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Prompt Assistant.lnk'
    Remove-Item -LiteralPath $startup -Force -ErrorAction SilentlyContinue
    $programs = Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Prompt Assistant'
    foreach ($name in @('Start Codex with Prompt Assistant.lnk','Uninstall Prompt Assistant.lnk','Check Prompt Assistant.lnk')) { Remove-Item -LiteralPath (Join-Path $programs $name) -Force -ErrorAction SilentlyContinue }
    if ((Test-Path -LiteralPath $programs) -and -not (Get-ChildItem -LiteralPath $programs -Force)) { Remove-Item -LiteralPath $programs -Force }
  }
  foreach ($name in @('launch.ps1','watch.vbs','launch.vbs','uninstall.ps1','diagnose.ps1','README.md','runtime','src')) { $item=Join-Path $full $name; if (Test-Path -LiteralPath $item) { Remove-Item -LiteralPath $item -Force -Recurse } }
  if (-not (Get-ChildItem -LiteralPath $full -Force)) { Remove-Item -LiteralPath $full -Force }
  Write-Host 'Codex Prompt Assistant removed.'
} catch { Write-Error $_; exit 1 }

