[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9]{8,80}$')][string]$ClientId,
    [ValidatePattern('^[A-Za-z0-9]{8,80}$')][string]$BackupClientId
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'Node.js 22 or newer is required. Do not enter secrets.' }
$version = & $node.Source --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Node.js 22 or newer is required. Do not enter secrets.' }
if ([bool]$ClientId -ne [bool]$BackupClientId) { throw 'Provide both public App keys, or neither.' }
$publicArguments = @()
if ($ClientId) { $publicArguments = @($ClientId, $BackupClientId) }
& $node.Source (Join-Path $PSScriptRoot 'connect-files.mjs') @publicArguments
$result = $LASTEXITCODE
[void](Read-Host 'Press Enter to close this window')
exit $result
