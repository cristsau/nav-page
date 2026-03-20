param(
  [string]$Ref = "master",
  [string]$RepoPath = "/opt/nav",
  [string]$SshConfig = "D:\domo\ssh\oracle-JP\config",
  [string]$HostAlias = "oracle-JP"
)

$ErrorActionPreference = "Stop"

Set-Location "D:\DomoCodex\projects\NAV"

$status = git status --porcelain
if ($status) {
  Write-Error "工作区还有未提交修改，请先提交后再部署。"
}

$branch = git branch --show-current
if (-not $branch) {
  Write-Error "无法识别当前 Git 分支。"
}

Write-Host "[deploy] pushing branch $branch to origin..."
git push origin $branch

Write-Host "[deploy] running remote deploy on $HostAlias ..."
$remoteCommand = "cd $RepoPath && NAV_DEPLOY_DIR=/home/web/html/nav bash ./scripts/deploy.sh $Ref"
ssh -F $SshConfig $HostAlias $remoteCommand

Write-Host "[deploy] done"
