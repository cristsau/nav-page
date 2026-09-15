param(
    [string]$SourceRef = 'origin/master',
    [string]$Version = '2026.09.15-compose.1'
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[a-z0-9][a-z0-9.-]{0,60}$') { throw 'Invalid package version' }
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$revision = (& git -C $repo rev-parse --verify "$SourceRef^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[a-f0-9]{40}$') { throw 'Source revision must resolve to a commit' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$build = Join-Path $repo "dist/compose-$stamp"
if (Test-Path -LiteralPath $build) { throw 'Output already exists; refusing overwrite' }
$name = "domonav-$Version"
$package = Join-Path $build $name
New-Item -ItemType Directory -Path (Join-Path $package 'source') | Out-Null
$sourceTar = Join-Path $build 'source.tar'
# Committed source only. No dirty tree, .env, diagnostics, operational scripts or Git history.
$paths = @('app/package.json','app/package-lock.json','app/index.html','app/vite.config.js','app/release-notes.json','app/build','app/src','app/public','api/package.json','api/package-lock.json','api/src','api/scripts')
& git -C $repo archive --format=tar -o $sourceTar $revision -- @paths
if ($LASTEXITCODE -ne 0) { throw 'Source archive failed' }
& tar -xf $sourceTar -C (Join-Path $package 'source')
if ($LASTEXITCODE -ne 0) { throw 'Source extraction failed' }
# A precise source-files exclusion is used by the final pack, not recursive deletion.
$excluded = @()
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $package 'source') -File -Recurse) {
    $relative = $file.FullName.Substring($package.Length + 1).Replace('\','/')
    if ($relative -match '/(?:\.env(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx|zip|crx))$' -or $relative -like 'source/app/public/downloads/*') { $excluded += $relative }
}
$files = @('compose.yaml','Dockerfile','.dockerignore','install.sh','manage.sh','setup.mjs','runtime.mjs','Caddyfile.template','README.md')
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $repo "selfhost/$file") -Destination (Join-Path $package $file) }
$utf8 = New-Object Text.UTF8Encoding($false)
# Freeze public official-image manifests. Anonymous registry bearer tokens are never printed or saved.
function Get-PublicImagePin([string]$Repository, [string]$Tag) {
    $auth = Invoke-RestMethod -Uri "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/${Repository}:pull"
    $headers = @{ Authorization = "Bearer $($auth.token)"; Accept = 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json' }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "https://registry-1.docker.io/v2/library/$Repository/manifests/$Tag" -Headers $headers
        $digest = @($response.Headers['Docker-Content-Digest'])[0]
        if ($digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Image digest missing' }
        $body = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }
        $manifest = $body | ConvertFrom-Json
        if (-not ($manifest.manifests | Where-Object { $_.platform.os -eq 'linux' -and $_.platform.architecture -eq 'amd64' })) { throw 'No Linux amd64 image' }
        return "${Repository}:${Tag}@$digest"
    } finally { $auth = $null; $headers = $null }
}
$images = [ordered]@{
    node = 'node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df'
    postgres = Get-PublicImagePin 'postgres' '16-alpine'
    caddy = Get-PublicImagePin 'caddy' '2-alpine'
}
[IO.File]::WriteAllText((Join-Path $package 'image-lock.json'), ($images | ConvertTo-Json) + "`n", $utf8)
$info = [ordered]@{ version=$Version; sourceRevision=$revision; packagedAtUtc=[DateTime]::UtcNow.ToString('o'); platform='linux/amd64'; status='candidate-requires-compose-acceptance'; sourceSelection='committed allowlist; no working-tree application changes' }
[IO.File]::WriteAllText((Join-Path $package 'package-info.json'), ($info | ConvertTo-Json) + "`n", $utf8)
$allowed = @(Get-ChildItem -LiteralPath $package -File -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($package.Length + 1).Replace('\','/')
    if ($relative -notin $excluded) { $relative }
} | Sort-Object)
$hashes = foreach ($relative in $allowed) { (Get-FileHash -LiteralPath (Join-Path $package $relative) -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $relative }
[IO.File]::WriteAllText((Join-Path $package 'SHA256SUMS'), ($hashes -join "`n") + "`n", $utf8)
$list = Join-Path $build 'archive-files.txt'
[IO.File]::WriteAllText($list, ((@($allowed) + 'SHA256SUMS' | ForEach-Object { "$name/$_" }) -join "`n") + "`n", $utf8)
$archive = Join-Path $build "$name.tar.gz"
& tar -czf $archive -C $build -T $list
if ($LASTEXITCODE -ne 0) { throw 'Package archive failed' }
$sha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$archive.sha256", "$sha  $name.tar.gz`n", $utf8)
[pscustomobject]@{ archive=$archive; sha256=$sha; sourceRevision=$revision; fileCount=($allowed.Count+1); bytes=(Get-Item -LiteralPath $archive).Length } | ConvertTo-Json
