$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'Node.js 22 or newer is required. Do not enter secrets in this window.' }
$version = & $node.Source --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Node.js 22 or newer is required. Do not enter secrets in this window.' }
& $node.Source (Join-Path $PSScriptRoot 'connect.mjs')
exit $LASTEXITCODE
