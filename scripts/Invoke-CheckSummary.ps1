#requires -Version 7.2
[CmdletBinding()]
param(
    [ValidateSet('Safety','Targeted','Full')][string]$Profile='Safety',
    [string[]]$TestFile,
    [ValidateRange(1,7200)][int]$TimeoutSeconds=900
)
$ErrorActionPreference='Stop'
$repository=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'CheckSummary.Common.ps1')
$node=(Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$unitRoot=(Resolve-Path -LiteralPath (Join-Path $repository 'api\test')).Path.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
if ($Profile -ne 'Targeted' -and $TestFile) { throw 'TestFile is accepted only with -Profile Targeted.' }
$steps=@()
    # Full means all api/test/*.test.js files, not frontend/DB/production release acceptance.
    $selected=@(switch($Profile) {
        'Full' { Get-ChildItem -LiteralPath $unitRoot -Filter '*.test.js' -File -Recurse | Sort-Object FullName | ForEach-Object FullName }
        'Safety' { 'api/test/safeUrl.test.js'; 'api/test/requestSecurity.test.js' }
        'Targeted' { $TestFile }
    })
    if (-not $selected.Count) { throw 'Targeted needs at least one exact api/test/*.test.js file.' }
    $paths=foreach($file in $selected) {
        $absolute=if([IO.Path]::IsPathFullyQualified($file)){$file}else{Join-Path $repository $file}
        $item=Get-Item -LiteralPath $absolute -ErrorAction Stop
        $resolved=[IO.Path]::GetFullPath($item.FullName)
        if ($item.PSIsContainer -or -not $resolved.StartsWith($unitRoot,[StringComparison]::OrdinalIgnoreCase) -or -not $resolved.EndsWith('.test.js',[StringComparison]::Ordinal)) { throw 'Only exact existing api/test/*.test.js files are allowed; no traversal or integration scripts.' }
        for($parent=$item; $null -ne $parent -and $parent.FullName -ne $repository; $parent=if($parent -is [IO.FileInfo]){$parent.Directory}else{$parent.Parent}) {
            if (($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse-point test paths are not accepted.' }
        }
        $resolved
    }
    $stepName=if($Profile -eq 'Full'){'api-all-unit-tests'}else{'selected-api-unit-tests'}
    $steps=@(@{Name=$stepName;FilePath=$node;Arguments=@('--test') + @($paths)})
$result=Invoke-LocalCheckSteps -Profile $Profile -ProjectRoot $repository -WorkingDirectory (Join-Path $repository 'api') -Steps $steps -TimeoutSeconds $TimeoutSeconds
Write-LocalCheckSummary -Result $result
exit $result.ExitCode
