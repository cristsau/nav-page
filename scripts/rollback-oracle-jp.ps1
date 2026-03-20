param(
  [Parameter(Mandatory = $true)]
  [string]$Ref,
  [string]$RepoPath = "/opt/nav",
  [string]$SshConfig = "D:\domo\ssh\oracle-JP\config",
  [string]$HostAlias = "oracle-JP"
)

$ErrorActionPreference = "Stop"

Write-Host "[rollback] running remote rollback on $HostAlias ..."
$remoteCommand = "cd $RepoPath && NAV_DEPLOY_DIR=/home/web/html/nav bash ./scripts/rollback.sh $Ref"
ssh -F $SshConfig $HostAlias $remoteCommand

Write-Host "[rollback] done"
