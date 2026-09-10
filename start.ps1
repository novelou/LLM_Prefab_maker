$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 22.12+ or 24+ is required.'
}
if (-not (Test-Path -LiteralPath 'node_modules')) {
  & npm.cmd ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host 'Open http://127.0.0.1:4173 in Chrome or Edge. Press Ctrl+C to stop.'
& npm.cmd start
