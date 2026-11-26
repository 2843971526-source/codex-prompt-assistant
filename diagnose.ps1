$ErrorActionPreference = 'Continue'
Write-Host 'Codex Prompt Assistant diagnostics'
$app = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if ($app) { Write-Host "Codex: installed ($($app.Version))" } else { Write-Host 'Codex: not found' }
$running = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.ExecutablePath -like '*\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe' -and $_.CommandLine -notmatch '--type=' })
if (-not $running.Count) { Write-Host 'Codex: not running' }
elseif ($running.CommandLine -match '--remote-debugging-port=\d+') { Write-Host 'Codex: debugging port enabled' }
else { Write-Host 'Codex: restart using Start Codex with Prompt Assistant' }
$watch = Join-Path $PSScriptRoot 'src\codex-draft-watch.mjs'
$watchers = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($watch) })
if ($watchers.Count) { Write-Host 'Watcher: running' } else { Write-Host 'Watcher: not running; use the start menu launcher' }
try {
  $response = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3
  Write-Host 'Ollama: reachable'
  if ($response.models.name -contains 'qwen3.5:4b') { Write-Host 'Model qwen3.5:4b: installed' }
  else { Write-Host 'Model missing. Run: ollama pull qwen3.5:4b' }
} catch { Write-Host 'Ollama: not reachable. Install or start Ollama: https://ollama.com/download' }
Write-Host ''
Read-Host 'Press Enter to close'

