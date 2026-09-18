# Windows-only local bootstrap store. No production transfer or cloud writes.
# Credentials arrive over stdin, never command arguments or plaintext files.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9]{8,80}$')][string]$ClientId,
    [ValidateSet('Check','Store')][string]$Mode = 'Check'
)
$ErrorActionPreference = 'Stop'
$plain = $null
$roundTrip = $null
$phase = 'INITIALIZE'
try {
    Add-Type -AssemblyName System.Security
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $base = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'),'DomoCodex','NavDropboxOAuth')
    $target = [IO.Path]::Combine($base,$ClientId)
    $cipherPath = [IO.Path]::Combine($target,'connection.dpapi')
    $phase = 'VERIFY_STORAGE_PATH'
    # Fail closed on any existing junction/symlink in the storage ancestry.
    for ($cursor=$target; $cursor; $cursor=Split-Path -Parent $cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $entry = Get-Item -LiteralPath $cursor -Force
            if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe_storage_path' }
        }
    }
    $phase = 'VERIFY_PRIVATE_ACL'
    foreach ($directory in @($base,$target)) {
        $phase = 'CHECK_DIRECTORY_OWNER'
        $created = $false
        if (-not (Test-Path -LiteralPath $directory)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
            $created = $true
        } else {
            $owner = (Get-Acl -LiteralPath $directory).GetOwner([Security.Principal.SecurityIdentifier])
            if ($owner.Value -ne $sid.Value) { throw 'storage_owner_mismatch' }
        }
        if ($created) {
            $acl = [Security.AccessControl.DirectorySecurity]::new()
            $phase = 'BUILD_PRIVATE_ACL'
            $acl.SetOwner($sid)
            $acl.SetAccessRuleProtection($true,$false)
            foreach ($principal in @($sid,$systemSid)) {
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
            }
            $phase = 'APPLY_PRIVATE_ACL'
            Set-Acl -LiteralPath $directory -AclObject $acl
        }
        # Existing stores are read-only at preflight: verify, never rewrite their ACL.
        $phase = 'READ_BACK_PRIVATE_ACL'
        $verifiedAcl = Get-Acl -LiteralPath $directory
        if (-not $verifiedAcl.AreAccessRulesProtected -or $verifiedAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'storage_acl_not_private' }
        $principals = @()
        foreach ($rule in $verifiedAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($sid.Value,$systemSid.Value) -or
                $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
                $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
                [int]$rule.InheritanceFlags -ne 3) { throw 'storage_acl_not_private' }
            $principals += $rule.IdentityReference.Value
        }
        if (@($principals | Select-Object -Unique).Count -ne 2) { throw 'storage_acl_not_private' }
    }
    $phase = 'CHECK_NO_OVERWRITE'
    if (Test-Path -LiteralPath $cipherPath) { throw 'connection_already_exists_no_overwrite' }
    $phase = 'VALIDATE_INPUT'
    if ($Mode -eq 'Check') {
        $plain = [Text.Encoding]::UTF8.GetBytes('NAV-DROPBOX-DPAPI-PREFLIGHT')
    } else {
        $text = [Console]::In.ReadToEnd()
        if ($text.Length -gt 32768) { throw 'invalid_credential_input' }
        $record = $text | ConvertFrom-Json
        $expectedScopes = @('account_info.read','files.metadata.read','files.content.read','files.content.write')
        if ($record.schema_version -ne 1 -or $record.provider -ne 'dropbox' -or $record.client_id -cne $ClientId -or
            [string]::IsNullOrWhiteSpace($record.refresh_token) -or [string]::IsNullOrWhiteSpace($record.account_id) -or
            @($record.scopes).Count -ne 4 -or @(Compare-Object $expectedScopes @($record.scopes)).Count -ne 0) { throw 'invalid_credential_input' }
        # Serialize only the permitted fields, never access_token, secret or user profile.
        $normalized = [ordered]@{
            schema_version=1; provider='dropbox'; client_id=$ClientId
            refresh_token=[string]$record.refresh_token; account_id=[string]$record.account_id
            scopes=$expectedScopes; authorized_at=[string]$record.authorized_at
        }
        $plain = [Text.Encoding]::UTF8.GetBytes(($normalized | ConvertTo-Json -Compress))
        $text=$null; $record=$null; $normalized=$null
    }
    $phase = 'DPAPI_ENCRYPT'
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $phase = 'DPAPI_DECRYPT'
    $roundTrip = [Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ([Convert]::ToBase64String($plain) -cne [Convert]::ToBase64String($roundTrip)) { throw 'dpapi_roundtrip_failed' }
    if ($Mode -eq 'Store') {
        $phase = 'WRITE_CIPHERTEXT'
        $file = [IO.File]::Open($cipherPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $file.Write($encrypted,0,$encrypted.Length); $file.Flush($true) } finally { $file.Dispose() }
        $stored = [IO.File]::ReadAllBytes($cipherPath)
        if ([Convert]::ToBase64String($stored) -cne [Convert]::ToBase64String($encrypted)) { throw 'encrypted_write_verification_failed' }
    }
    @{status=if($Mode -eq 'Store'){'LOCAL_AUTHORIZATION_SAVED'}else{'LOCAL_STORE_READY'}; secret_logged=$false} | ConvertTo-Json -Compress
} catch {
    # Deliberately do not echo exception messages or stdin, including parse failures.
    $safeReasons = @('unsafe_storage_path','storage_owner_mismatch','storage_acl_not_private','connection_already_exists_no_overwrite','invalid_credential_input','dpapi_roundtrip_failed','encrypted_write_verification_failed')
    $reason = if ($_.Exception.Message -cin $safeReasons) {$_.Exception.Message} else {'platform_error'}
    @{status='LOCAL_STORE_FAILED'; phase=$phase; reason=$reason; platform_code=$_.Exception.HResult; secret_logged=$false} | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($plain) { [Array]::Clear($plain,0,$plain.Length) }
    if ($roundTrip) { [Array]::Clear($roundTrip,0,$roundTrip.Length) }
}
