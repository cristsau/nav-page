param(
  [string]$RepoPath = "/opt/nav",
  [string]$SshConfig = "D:\domo\ssh\oracle-JP\config",
  [string]$HostAlias = "oracle-JP"
)

$ErrorActionPreference = "Stop"

Write-Host "[backend] deploying backend on $HostAlias ..."
$remoteCommand = "cd $RepoPath && bash ./scripts/deploy-backend.sh"
ssh -F $SshConfig $HostAlias $remoteCommand

Write-Host "[backend] done"
