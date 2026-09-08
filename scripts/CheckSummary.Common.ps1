#requires -Version 7.2
# Local-only check runner: explicit steps, no shell strings, bounded output and failure propagation.
Set-StrictMode -Version Latest
function Write-LocalCheckSummary {
    param([Parameter(Mandatory)]$Result)
    $summary=[ordered]@{status=$Result.Status;profile=$Result.Profile;checks=($Result.Completed.ToString()+'/'+$Result.Selected);seconds=$Result.DurationSeconds;scope='local-profile-only';log=$Result.LogPath}
    if($Result.LogTruncated){$summary['logTruncated']=$true}
    if($Result.ExitCode -ne 0){$summary['exitCode']=$Result.ExitCode;$summary['failedSteps']=@($Result.Steps | Where-Object ExitCode -ne 0 | ForEach-Object Name);$summary['failure']=$Result.FailureExcerpt}
    $summary | ConvertTo-Json -Depth 3 -Compress
}
function Invoke-LocalCheckSteps {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Profile,
        [Parameter(Mandatory)][string]$ProjectRoot,
        [string]$WorkingDirectory,
        [Parameter(Mandatory)][object[]]$Steps,
        [ValidateRange(1,7200)][int]$TimeoutSeconds = 900,
        [string]$LogRoot = (Join-Path ([IO.Path]::GetTempPath()) 'CodexLocalChecks')
    )
    if (-not $Steps.Count) { throw 'No checks selected.' }
    $root = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
    $work = if($WorkingDirectory){(Resolve-Path -LiteralPath $WorkingDirectory -ErrorAction Stop).Path}else{$root}
    $prefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not [IO.Directory]::Exists($work) -or ($work -ne $root -and -not $work.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase))) { throw 'Check working directory must stay inside the selected project.' }
    [IO.Directory]::CreateDirectory($LogRoot) | Out-Null
    $label = ([IO.Path]::GetFileName($root) + '-' + $Profile) -replace '[^a-zA-Z0-9_-]', '_'
    $log = Join-Path $LogRoot ($label + '-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N') + '.log')
    $stream = [IO.File]::Open($log, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
    $tail = [Collections.Generic.Queue[string]]::new()
    $results = [Collections.Generic.List[object]]::new()
    $state = @{ Lines=0; Characters=0; Truncated=$false }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $record = {
        param([string]$Line)
        $clean = $Line -replace '\x1B\[[0-?]*[ -/]*[@-~]', ''
        $clean = $clean -replace '(?i)(["'']?\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\b["'']?\s*[:=]\s*)("[^"]*"|''[^'']*''|[^\s,;]+)', '$1[REDACTED]'
        $clean = $clean -replace '(?i)(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*).*', '$1[REDACTED]'
        $clean = $clean -replace '(?i)(\bBearer\s+)[A-Za-z0-9._~+/-]+', '$1[REDACTED]'
        $clean = $clean -replace '(https?://)[^/\s:@]+:[^@\s/]+@', '$1[REDACTED]@'
        if ($clean.Length -gt 16000) { $clean = $clean.Substring(0,16000) + ' [LINE_TRUNCATED]'; $state.Truncated=$true }
        $state.Lines++
        if ($state.Characters -lt 20000000) { $writer.WriteLine($clean); $state.Characters += $clean.Length }
        else { $state.Truncated=$true }
        $tail.Enqueue($clean)
        while ($tail.Count -gt 20) { $null=$tail.Dequeue() }
    }
    try {
        foreach ($step in $Steps) {
            $stepWatch=[Diagnostics.Stopwatch]::StartNew()
            $exitCode=1
            $process=[Diagnostics.Process]::new()
            try {
                if (-not [IO.Path]::IsPathFullyQualified($step.FilePath) -or -not (Test-Path -LiteralPath $step.FilePath -PathType Leaf)) { throw 'Check executable must be an existing absolute file.' }
                $start=[Diagnostics.ProcessStartInfo]::new()
                $start.FileName=$step.FilePath
                $start.WorkingDirectory=$work
                $start.UseShellExecute=$false
                $start.CreateNoWindow=$true
                $start.RedirectStandardOutput=$true
                $start.RedirectStandardError=$true
                foreach($argument in $step.Arguments) { $start.ArgumentList.Add([string]$argument) }
                $process.StartInfo=$start
                & $record ('STEP ' + $step.Name)
                if (-not $process.Start()) { throw 'Unable to start selected check.' }
                $stdout=$process.StandardOutput.ReadLineAsync()
                $stderr=$process.StandardError.ReadLineAsync()
                $timedOut=$false
                while ($null -ne $stdout -or $null -ne $stderr -or -not $process.HasExited) {
                    $madeProgress=$false
                    if ($stepWatch.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
                        $timedOut=$true
                        if (-not $process.HasExited) { $process.Kill($true); $null=$process.WaitForExit(5000) }
                        & $record 'CHECK_TIMEOUT: owned local check process tree terminated.'
                        break
                    }
                    if ($null -ne $stdout -and $stdout.IsCompleted) {
                        $madeProgress=$true
                        $line=$stdout.GetAwaiter().GetResult()
                        if ($null -eq $line) { $stdout=$null }
                        else { & $record $line; $stdout=$process.StandardOutput.ReadLineAsync() }
                    }
                    if ($null -ne $stderr -and $stderr.IsCompleted) {
                        $madeProgress=$true
                        $line=$stderr.GetAwaiter().GetResult()
                        if ($null -eq $line) { $stderr=$null }
                        else { & $record ('STDERR ' + $line); $stderr=$process.StandardError.ReadLineAsync() }
                    }
                    if (-not $madeProgress -and ($null -ne $stdout -or $null -ne $stderr -or -not $process.HasExited)) { Start-Sleep -Milliseconds 10 }
                }
                $exitCode=if($timedOut){124}else{$process.ExitCode}
            } catch {
                & $record ('CHECK_ERROR ' + $_.Exception.Message)
                $exitCode=1
            } finally {
                try { if ($process.Id -and -not $process.HasExited) { $process.Kill($true); $null=$process.WaitForExit(5000) } } catch {}
                $process.Dispose()
            }
            $results.Add([pscustomobject]@{Name=$step.Name;ExitCode=$exitCode;Seconds=[Math]::Round($stepWatch.Elapsed.TotalSeconds,2)})
            if ($exitCode -ne 0) { break }
        }
    } finally { $writer.Dispose() }
    $failed=@($results | Where-Object ExitCode -ne 0)
    $code=if($failed.Count){[int]$failed[0].ExitCode}elseif($results.Count -ne $Steps.Count){1}else{0}
    $excerpt=if($code -ne 0){@($tail.ToArray()) -join [Environment]::NewLine}else{''}
    if ($excerpt.Length -gt 8000) { $excerpt=$excerpt.Substring($excerpt.Length-8000) }
    [pscustomobject]@{
        Status=if($code -eq 0){'PASS'}else{'FAIL'}
        Profile=$Profile; Scope='selected-local-checks-only'; ExitCode=$code
        Selected=$Steps.Count; Completed=$results.Count
        DurationSeconds=[Math]::Round($watch.Elapsed.TotalSeconds,2)
        Steps=$results.ToArray(); LogPath=$log; OutputLines=$state.Lines
        LogTruncated=$state.Truncated; FailureExcerpt=$excerpt
    }
}
