# Synthetic credentials only. Run as the actual test user in a local PowerShell process.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$fixtureId='NavFixture'+[Guid]::NewGuid().ToString('N')
$privateBase=[IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'),'DomoCodex','NavDropboxOAuth')
$fixtureDirectory=Join-Path $privateBase $fixtureId
$fixtureFile=Join-Path $fixtureDirectory 'connection.dpapi'
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$fixtureSecret='SYNTHETIC-REFRESH-NOT-A-REAL-TOKEN'
try {
    if (Test-Path -LiteralPath $fixtureDirectory) {throw 'Unexpected existing fixture'}
    $preflight=& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Save-Connection.ps1') -ClientId $fixtureId -Mode Check
    if ($LASTEXITCODE -ne 0 -or ($preflight | ConvertFrom-Json).status -ne 'LOCAL_STORE_READY') {Write-Output $preflight; throw 'Synthetic DPAPI preflight failed'}
    $secondCheck=& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Save-Connection.ps1') -ClientId $fixtureId -Mode Check
    if ($LASTEXITCODE -ne 0 -or ($secondCheck | ConvertFrom-Json).status -ne 'LOCAL_STORE_READY') {Write-Output $secondCheck; throw 'Repeated preflight failed'}
    $json=@{schema_version=1; provider='dropbox'; client_id=$fixtureId; refresh_token=$fixtureSecret; account_id='dbid:SYNTHETIC'; scopes=@('account_info.read','files.metadata.read','files.content.read','files.content.write'); authorized_at='2026-09-18T00:00:00Z'} | ConvertTo-Json -Compress
    $receipt=$json | & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Save-Connection.ps1') -ClientId $fixtureId -Mode Store
    if ($LASTEXITCODE -ne 0 -or ($receipt | ConvertFrom-Json).status -ne 'LOCAL_AUTHORIZATION_SAVED') {Write-Output $receipt; throw 'Synthetic DPAPI store failed'}
    $cipher=[IO.File]::ReadAllBytes($fixtureFile)
    if ([Text.Encoding]::UTF8.GetString($cipher).Contains($fixtureSecret)) {throw 'Plaintext persisted'}
    $decoded=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $payload=[Text.Encoding]::UTF8.GetString($decoded) | ConvertFrom-Json
    if ($payload.refresh_token -cne $fixtureSecret -or $payload.client_id -cne $fixtureId) {throw 'Synthetic decrypt roundtrip failed'}
    [Array]::Clear($decoded,0,$decoded.Length)
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl=Get-Acl -LiteralPath $fixtureFile
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($sid,'S-1-5-18')) {throw 'Fixture file has unexpected ACL'}
    }
    $oldHash=(Get-FileHash -LiteralPath $fixtureFile -Algorithm SHA256).Hash
    $again=$json | & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Save-Connection.ps1') -ClientId $fixtureId -Mode Store
    if ($LASTEXITCODE -eq 0 -or (Get-FileHash -LiteralPath $fixtureFile -Algorithm SHA256).Hash -cne $oldHash) {throw 'Existing connection overwrite not rejected'}
    if (($receipt+$again+$preflight) -match [regex]::Escape($fixtureSecret)) {throw 'Secret in output'}
    Write-Output 'SYNTHETIC_DPAPI_ACL_ROUNDTRIP_AND_NO_OVERWRITE_PASS'
} finally {
    # Only the unpredictable fixture made above. No recursive deletion or real app directory.
    if ([IO.Path]::GetFullPath($fixtureDirectory) -cne [IO.Path]::Combine($privateBase,$fixtureId) -or $fixtureId -notmatch '^NavFixture[a-f0-9]{32}$') {throw 'Unsafe fixture cleanup path'}
    if (Test-Path -LiteralPath $fixtureFile) {
        if ((Get-Item -LiteralPath $fixtureFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Unsafe fixture file'}
        Remove-Item -LiteralPath $fixtureFile -Force
    }
    if (Test-Path -LiteralPath $fixtureDirectory) {
        if ((Get-Item -LiteralPath $fixtureDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Unsafe fixture directory'}
        # Non-recursive remove must never encounter anything except this test's single file.
        if (@(Get-ChildItem -LiteralPath $fixtureDirectory -Force).Count -ne 0) {throw 'Unexpected fixture contents retained'}
        [IO.Directory]::Delete($fixtureDirectory,$false)
    }
}
