param(
    [switch]$NoUi,
    [switch]$SkipDocker,
    [int]$DockerTimeoutSeconds = 180,
    [int]$ServiceTimeoutSeconds = 150
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ComposeDir = Join-Path $ScriptDir 'compose'
$BinDir = Join-Path $ScriptDir 'bin'
$ComposeFile = Join-Path $ComposeDir 'docker-compose.yml'
$RuntimeComposeDir = Join-Path $env:USERPROFILE '.jarvis\compose'
$EnvFile = Join-Path $RuntimeComposeDir '.env'
$AdminServer = Join-Path $ScriptDir 'source\jarvis-admin\server\dist\index.js'
$AdminPublic = Join-Path $BinDir 'public'
$DesktopStable = Join-Path $ScriptDir 'source\jarvis-admin\desktop-dist\win-unpacked\JARVIS Neural Interface.exe'
$DesktopPortable = Join-Path $ScriptDir 'source\jarvis-admin\desktop-dist\JARVIS-Neural-Interface-0.0.0.exe'
$ElectronExe = Join-Path $ScriptDir 'source\jarvis-admin\node_modules\electron\dist\electron.exe'
$ElectronApp = Join-Path $ScriptDir 'source\jarvis-admin'
$LogDir = Join-Path $ScriptDir 'logs'
$StartupLog = Join-Path $LogDir 'startup-latest.log'
$StartupReport = Join-Path $LogDir 'startup-latest.json'
$PersistedAdminConfig = Join-Path $env:USERPROFILE '.jarvis\admin.json'
$DockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$DockerBackendLog = Join-Path $env:LOCALAPPDATA 'Docker\log\host\com.docker.backend.exe.log'
$UiUrl = 'http://127.0.0.1:7711'
$DockerCli = (Get-Command docker -ErrorAction Stop).Source
$script:CurrentStage = 'initialization'
$script:UiStarted = $false

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-LaunchEvent {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'OK', 'WARN', 'ERROR')][string]$Level = 'INFO'
    )

    $line = '[{0}] [{1}] [{2}] {3}' -f (Get-Date).ToString('s'), $Level, $script:CurrentStage, $Message
    Add-Content -LiteralPath $StartupLog -Value $line -Encoding UTF8
    $color = switch ($Level) {
        'OK' { 'Green' }
        'WARN' { 'Yellow' }
        'ERROR' { 'Red' }
        default { 'Cyan' }
    }
    Write-Host $line -ForegroundColor $color
}

function Write-StartupReport {
    param(
        [ValidateSet('starting', 'ready', 'failed', 'degraded')][string]$Status,
        [string]$Message
    )

    $report = [ordered]@{
        status = $Status
        stage = $script:CurrentStage
        message = $Message
        timestamp = (Get-Date).ToString('o')
        log = $StartupLog
        ui = $UiUrl
    }
    $json = $report | ConvertTo-Json
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($StartupReport, $json, $utf8NoBom)
}

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [int]$TimeoutSeconds = 45,
        [switch]$AllowFailure
    )

    $payload = [ordered]@{
        executable = $FilePath
        arguments = @($ArgumentList)
    } | ConvertTo-Json -Compress

    $job = Start-Job -ScriptBlock {
        param([string]$PayloadJson)
        $command = $PayloadJson | ConvertFrom-Json
        # Docker Compose reports normal progress on stderr. Convert every
        # native stream item to plain text inside the job so PowerShell does
        # not serialize successful progress as RemoteException diagnostics.
        $ErrorActionPreference = 'Continue'
        $captured = @(& $command.executable @($command.arguments) 2>&1 | ForEach-Object { [string]$_ })
        [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output = (($captured | Out-String).Trim())
        }
    } -ArgumentList $payload

    try {
        $completed = Wait-Job -Job $job -Timeout $TimeoutSeconds
        if (-not $completed) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            throw "Process timed out after $TimeoutSeconds seconds: $FilePath $($ArgumentList -join ' ')"
        }

        $result = Receive-Job -Job $job
        if (-not $result) {
            throw "Process returned no result: $FilePath $($ArgumentList -join ' ')"
        }
        if (-not $AllowFailure -and [int]$result.ExitCode -ne 0) {
            throw "Process exited with code $($result.ExitCode): $FilePath $($ArgumentList -join ' ')`n$($result.Output)"
        }
        return $result
    } finally {
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
}

function Get-DockerFailureSummary {
    if (-not (Test-Path -LiteralPath $DockerBackendLog)) {
        return 'Docker backend log was not found.'
    }

    $failure = Get-Content -LiteralPath $DockerBackendLog -Tail 250 -ErrorAction SilentlyContinue |
        Select-String -Pattern 'backend (?:crashed|cancelling) with error:' |
        Select-Object -Last 1
    if ($failure) {
        return ($failure.Line -replace '^.*backend (?:crashed|cancelling) with error:\s*', '')
    }
    return 'Docker did not expose a recent backend crash reason.'
}

function Repair-StaleDockerRuntimeSocket {
    param([datetime]$NotOlderThan)

    if (-not (Test-Path -LiteralPath $DockerBackendLog)) { return $false }

    $backendLog = Get-Item -LiteralPath $DockerBackendLog -ErrorAction SilentlyContinue
    if (-not $backendLog -or $backendLog.LastWriteTime -lt $NotOlderThan.AddSeconds(-5)) {
        return $false
    }

    $failure = Get-DockerFailureSummary
    if ($failure -notmatch 'listening on unix://(?<socket>[A-Za-z]:/[^:]+).*The file cannot be accessed by the system') {
        return $false
    }

    $reportedPath = $matches['socket'].Replace('/', '\')
    $allowedPaths = @(
        (Join-Path $env:LOCALAPPDATA 'Docker\run\dockerInference'),
        (Join-Path $env:LOCALAPPDATA 'Docker\run\sailor-ingest.sock'),
        (Join-Path $env:LOCALAPPDATA 'Docker\run\userAnalyticsOtlpHttp.sock'),
        (Join-Path $env:LOCALAPPDATA 'Docker\run\dockerEthernetVfkit'),
        (Join-Path $env:LOCALAPPDATA 'docker-secrets-engine\engine.sock')
    )
    $target = $allowedPaths | Where-Object {
        [string]::Equals($_, $reportedPath, [System.StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1

    if (-not $target -or -not (Test-Path -LiteralPath $target)) {
        return $false
    }

    Write-LaunchEvent "Docker reported a stale runtime socket at $target. Performing one scoped self-repair." 'WARN'
    Get-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.build', 'com.docker.proxy', 'dockerd' -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # Docker Desktop occasionally leaves a Windows reparse placeholder that
    # every Win32 file API reports as inaccessible. Preserve the exact target
    # in a scoped backup. The secrets engine owns its whole directory, so move
    # that directory as one recoverable unit; Docker's run sockets can be moved
    # through the distro's host mount when Win32 cannot open them.
    # Once one invalid listener is confirmed, quarantine the complete exact
    # runtime allowlist before restarting Docker. Restarting after only one
    # move lets Docker recreate an earlier bad reparse point while it fails on
    # the next listener. These paths contain no images, volumes, or containers.
    $targetsToRepair = @($allowedPaths | Where-Object { Test-Path -LiteralPath $_ -ErrorAction SilentlyContinue })
    $backupRecords = [System.Collections.Generic.List[string]]::new()
    $secretsTarget = Join-Path $env:LOCALAPPDATA 'docker-secrets-engine\engine.sock'
    $backupDir = Join-Path $env:LOCALAPPDATA 'Docker\run\jarvis-stale-runtime-backup'
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $wsl = (Get-Command wsl.exe -ErrorAction Stop).Source
    $toWslPath = {
        param([string]$WindowsPath)
        $drive = $WindowsPath.Substring(0, 1).ToLowerInvariant()
        $rest = $WindowsPath.Substring(2).Replace('\', '/')
        return "/mnt/host/$drive$rest"
    }

    foreach ($socketTarget in $targetsToRepair) {
        if ([string]::Equals($socketTarget, $secretsTarget, [System.StringComparison]::OrdinalIgnoreCase)) {
            $secretsDir = Split-Path -Parent $socketTarget
            $socketBackup = '{0}.stale-{1}' -f $secretsDir, (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
            Rename-Item -LiteralPath $secretsDir -NewName ([IO.Path]::GetFileName($socketBackup)) -ErrorAction Stop
            New-Item -ItemType Directory -Path $secretsDir -Force | Out-Null
        } else {
            $backupName = '{0}.{1}' -f ([IO.Path]::GetFileName($socketTarget)), (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
            $socketBackup = Join-Path $backupDir $backupName
            try {
                Move-Item -LiteralPath $socketTarget -Destination $socketBackup -Force -ErrorAction Stop
            } catch {
                $wslTarget = & $toWslPath $socketTarget
                $wslBackupDir = & $toWslPath $backupDir
                $wslBackupPath = & $toWslPath $socketBackup
                $moveScript = "mkdir -p '$wslBackupDir' && mv -f '$wslTarget' '$wslBackupPath'"
                $moveResult = Invoke-BoundedProcess -FilePath $wsl -ArgumentList @('-d', 'docker-desktop', '--', 'sh', '-lc', $moveScript) -TimeoutSeconds 20 -AllowFailure
                if ([int]$moveResult.ExitCode -ne 0) {
                    throw "Docker runtime socket could not be moved recoverably: $($moveResult.Output)"
                }
            }
        }
        if (Test-Path -LiteralPath $socketTarget -ErrorAction SilentlyContinue) {
            throw "Docker runtime socket repair did not move $socketTarget."
        }
        $backupRecords.Add("$socketTarget -> $socketBackup")
    }

    # These three listeners require a regular placeholder on this host; Docker
    # replaces it cleanly. Analytics and secrets are recreated by their owners.
    foreach ($placeholderName in @('sailor-ingest.sock', 'dockerInference', 'dockerEthernetVfkit')) {
        $placeholderPath = Join-Path (Join-Path $env:LOCALAPPDATA 'Docker\run') $placeholderName
        if (-not (Test-Path -LiteralPath $placeholderPath -ErrorAction SilentlyContinue)) {
            [IO.File]::WriteAllBytes($placeholderPath, [byte[]]::new(0))
        }
    }

    Write-LaunchEvent "Recovered $($backupRecords.Count) stale Docker runtime path(s) into scoped backups. No images, volumes, containers, or user data were changed." 'OK'
    Start-Process -FilePath $DockerDesktop -WindowStyle Hidden
    return $true
}

function Test-DockerReady {
    try {
        $result = Invoke-BoundedProcess -FilePath $DockerCli -ArgumentList @('version', '--format', '{{.Server.Version}}') -TimeoutSeconds 8 -AllowFailure
        return [int]$result.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$result.Output)
    } catch {
        return $false
    }
}

function Wait-DockerReady {
    param([int]$TimeoutSeconds)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $nextProgress = Get-Date
    do {
        if (Test-DockerReady) { return $true }
        if ((Get-Date) -ge $nextProgress) {
            Write-LaunchEvent 'Waiting for the Docker Linux engine API...'
            $nextProgress = (Get-Date).AddSeconds(15)
        }
        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Invoke-ComposeUp {
    param(
        [Parameter(Mandatory = $true)][string[]]$Services,
        [int]$TimeoutSeconds = 120
    )

    $args = @('compose', '-f', $ComposeFile, '--env-file', $EnvFile, 'up', '-d', '--pull', 'never') + $Services
    $result = Invoke-BoundedProcess -FilePath $DockerCli -ArgumentList $args -TimeoutSeconds $TimeoutSeconds
    if ($result.Output) { Write-LaunchEvent $result.Output }
}

function Set-RuntimeEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )

    if (-not (Test-Path -LiteralPath $EnvFile)) {
        throw "Jarvis runtime environment file is missing: $EnvFile"
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    $found = $false
    $pattern = '^{0}=' -f [regex]::Escape($Key)
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
        if ($line -match $pattern) {
            if (-not $found) {
                $lines.Add("$Key=$Value")
                $found = $true
            }
            continue
        }
        $lines.Add($line)
    }
    if (-not $found) { $lines.Add("$Key=$Value") }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($EnvFile, $lines, $utf8NoBom)
}

function Get-RuntimeEnvValue {
    param([Parameter(Mandatory = $true)][string]$Key)

    $pattern = '^{0}=(.*)$' -f [regex]::Escape($Key)
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
        if ($line -match $pattern) { return $matches[1] }
    }
    return $null
}

function Ensure-RuntimeComposeSettings {
    # Do not rely on HOME in a Windows background job: PowerShell 5.1 does not
    # consistently export it. Keep the admin container pointed at the
    # authoritative runtime compose directory and private infra on loopback.
    $runtimeComposePath = $RuntimeComposeDir.Replace('\', '/')
    Set-RuntimeEnvValue -Key 'JARVIS_HOST_COMPOSE_DIR' -Value $runtimeComposePath
    Set-RuntimeEnvValue -Key 'JARVIS_INFRA_BIND_HOST' -Value '127.0.0.1'
}

function Mark-JarvisRuntimeReady {
    # Persist only non-secret lifecycle metadata. This marker is deliberately
    # independent of Docker/WSL uptime so a normal WSL shutdown returns to an
    # offline dashboard instead of restarting the setup wizard. Explicit reset
    # or initialization remains the only path that clears this state.
    if (-not (Test-Path -LiteralPath $PersistedAdminConfig)) { return }
    try {
        $current = Get-Content -LiteralPath $PersistedAdminConfig -Raw -ErrorAction Stop | ConvertFrom-Json
        $current | Add-Member -NotePropertyName installed -NotePropertyValue $true -Force
        $current | Add-Member -NotePropertyName runtimeState -NotePropertyValue 'ready' -Force
        $current | Add-Member -NotePropertyName lastReadyAt -NotePropertyValue (Get-Date).ToString('o') -Force
        $json = $current | ConvertTo-Json -Depth 8
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($PersistedAdminConfig, "$json`n", $utf8NoBom)
        Write-LaunchEvent 'Persisted Jarvis runtime state as ready.' 'OK'
    } catch {
        Write-LaunchEvent "Could not persist runtime state: $($_.Exception.Message)" 'WARN'
    }
}

function Assert-DockerPortAvailableForJarvis {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$ExpectedContainer,
        [Parameter(Mandatory = $true)][string]$ServiceName
    )

    $result = Invoke-BoundedProcess -FilePath $DockerCli -ArgumentList @('ps', '--format', '{{.Names}}|{{.Ports}}') -TimeoutSeconds 10 -AllowFailure
    if ([int]$result.ExitCode -ne 0) { return }

    $publishedPort = '(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|::|\*):{0}->' -f $Port
    foreach ($line in ([string]$result.Output -split "`r?`n")) {
        if ($line -notmatch '^([^|]+)\|(.*)$') { continue }
        $containerName = $matches[1]
        $ports = $matches[2]
        if ($ports -match $publishedPort -and $containerName -ne $ExpectedContainer) {
            throw "$ServiceName host port $Port is already allocated by Docker container '$containerName'. Update its *_PORT setting or stop that conflicting stack before starting Jarvis."
        }
    }
}

function Get-ContainerState {
    param([string]$ContainerName)

    $format = '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
    $result = Invoke-BoundedProcess -FilePath $DockerCli -ArgumentList @('inspect', '--format', $format, $ContainerName) -TimeoutSeconds 8 -AllowFailure
    if ([int]$result.ExitCode -ne 0) { return 'missing' }
    return ([string]$result.Output).Trim().ToLowerInvariant()
}

function Wait-ContainerState {
    param(
        [Parameter(Mandatory = $true)][string]$ContainerName,
        [string[]]$AcceptedStates = @('running', 'healthy'),
        [int]$TimeoutSeconds = 90
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastState = 'unknown'
    do {
        try { $lastState = Get-ContainerState -ContainerName $ContainerName } catch { $lastState = $_.Exception.Message }
        if ($AcceptedStates -contains $lastState) { return $true }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    throw "$ContainerName did not reach $($AcceptedStates -join ' or ') within $TimeoutSeconds seconds (last state: $lastState)."
}

function Wait-HttpReady {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Url,
        [int]$TimeoutSeconds = 90
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = 'No response'
    do {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 4
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                Write-LaunchEvent "$Name ready at $Url" 'OK'
                return $true
            }
            $lastError = "HTTP $($response.StatusCode)"
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    throw "$Name did not become ready within $TimeoutSeconds seconds at $Url. Last error: $lastError"
}

function Test-DockerImage {
    param([string]$Image)
    try {
        $result = Invoke-BoundedProcess -FilePath $DockerCli -ArgumentList @('image', 'inspect', '--format', '{{.Id}}', $Image) -TimeoutSeconds 10 -AllowFailure
        return [int]$result.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$result.Output)
    } catch {
        return $false
    }
}

function Add-ComposeDiagnosticsToLog {
    param([string[]]$Services)
    if (-not (Test-DockerReady)) { return }

    try {
        $psArgs = @('compose', '-f', $ComposeFile, '--env-file', $EnvFile, 'ps')
        $snapshot = Invoke-BoundedProcess -FilePath $DockerCli -ArgumentList $psArgs -TimeoutSeconds 15 -AllowFailure
        if ($snapshot.Output) {
            Add-Content -LiteralPath $StartupLog -Value "`n--- docker compose ps ---`n$($snapshot.Output)" -Encoding UTF8
        }
    } catch {}

    if ($Services.Count -gt 0) {
        try {
            $logArgs = @('compose', '-f', $ComposeFile, '--env-file', $EnvFile, 'logs', '--tail', '80', '--no-color') + $Services
            $logs = Invoke-BoundedProcess -FilePath $DockerCli -ArgumentList $logArgs -TimeoutSeconds 20 -AllowFailure
            if ($logs.Output) {
                Add-Content -LiteralPath $StartupLog -Value "`n--- failing service logs ---`n$($logs.Output)" -Encoding UTF8
            }
        } catch {}
    }
}

function Ensure-AdminServer {
    try {
        $response = Invoke-WebRequest -Uri "$UiUrl/health" -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -eq 200) {
            Write-LaunchEvent 'Jarvis dashboard server is already ready.' 'OK'
            return
        }
    } catch {}

    if (-not (Test-Path -LiteralPath $AdminServer)) {
        throw 'The Jarvis dashboard server build is missing. Re-run the local setup.'
    }

    $node = (Get-Command node -ErrorAction Stop).Source
    $env:PORT = '7711'
    $env:JARVIS_ADMIN_BIND_HOST = '127.0.0.1'
    $env:STATIC_DIR = $AdminPublic
    $env:JARVIS_FORCE_INSTALL = '1'
    $env:JARVIS_AUTH_BASE_URL = 'http://127.0.0.1:7701'
    $env:JARVIS_CONFIG_URL = 'http://127.0.0.1:7700'
    $env:JARVIS_LLM_PROXY_URL = 'http://127.0.0.1:7704'
    $env:JARVIS_COMMAND_CENTER_URL = 'http://127.0.0.1:7703'
    $env:JARVIS_NATIVE_LLM_URL = 'http://127.0.0.1:7704'
    $env:JARVIS_WHISPER_URL = 'http://127.0.0.1:7706'
    $env:JARVIS_TTS_URL = 'http://127.0.0.1:7707'
    $env:JARVIS_PRIMARY_HOUSEHOLD_ID = 'a47e80e0-801c-4969-9641-c25c4f1006c7'
    $env:JARVIS_STOP_SCRIPT = (Join-Path $ScriptDir 'stop-jarvis.ps1')
    $env:JARVIS_STARTUP_REPORT = $StartupReport
    foreach ($line in Get-Content -LiteralPath $EnvFile) {
        if ($line -match '^(JARVIS_APP_ID_COMMAND_CENTER|JARVIS_APP_KEY_COMMAND_CENTER)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }

    Start-Process -FilePath $node -ArgumentList $AdminServer -WorkingDirectory (Split-Path $AdminServer -Parent) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogDir 'admin.out.log') -RedirectStandardError (Join-Path $LogDir 'admin.err.log')
    Wait-HttpReady -Name 'Jarvis dashboard server' -Url "$UiUrl/health" -TimeoutSeconds 60 | Out-Null
}

function Start-NativeInterface {
    if ($NoUi -or $script:UiStarted) { return }

    $env:JARVIS_ROOT_DIR = $ScriptDir
    # Prefer the stable unpacked executable. Windows records microphone access
    # for non-packaged desktop apps by executable path; electron-builder's
    # portable target extracts into a different random Temp directory on every
    # launch, which makes microphone permission unreliable across restarts.
    if (Test-Path -LiteralPath $DesktopStable) {
        Start-Process -FilePath $DesktopStable -WorkingDirectory (Split-Path $DesktopStable -Parent)
        $script:UiStarted = $true
        Write-LaunchEvent 'JARVIS native Electron interface launched from its stable microphone identity.' 'OK'
        return
    }
    if (Test-Path -LiteralPath $DesktopPortable) {
        Start-Process -FilePath $DesktopPortable
        $script:UiStarted = $true
        Write-LaunchEvent 'JARVIS native Electron interface launched.' 'OK'
        return
    }
    if (Test-Path -LiteralPath $ElectronExe) {
        Start-Process -FilePath $ElectronExe -ArgumentList $ElectronApp -WorkingDirectory $ElectronApp
        $script:UiStarted = $true
        Write-LaunchEvent 'JARVIS Electron development shell launched.' 'OK'
        return
    }
    throw 'No Jarvis Electron executable was found.'
}

$launcherMutex = New-Object System.Threading.Mutex($false, 'Local\JarvisLocalStackLauncher')
$ownsMutex = $false
$servicesForDiagnostics = @()

try {
    $ownsMutex = $launcherMutex.WaitOne(0, $false)
    if (-not $ownsMutex) {
        Write-LaunchEvent 'Another Jarvis startup is already running; this duplicate launch will exit.' 'WARN'
        exit 0
    }

    Set-Content -LiteralPath $StartupLog -Value '' -Encoding UTF8
    Write-StartupReport -Status 'starting' -Message 'Jarvis startup is in progress.'

    $script:CurrentStage = 'local-inference'
    Write-LaunchEvent 'Starting the native CUDA llama.cpp service...'
    & (Join-Path $ScriptDir 'start-local-llm.ps1') -TimeoutSeconds 120
    Wait-HttpReady -Name 'Local Qwen inference' -Url 'http://127.0.0.1:7704/health' -TimeoutSeconds 10 | Out-Null

    if (-not $SkipDocker) {
        $script:CurrentStage = 'docker-engine'
        if (-not (Test-DockerReady)) {
            if (-not (Test-Path -LiteralPath $DockerDesktop)) {
                throw 'Docker Desktop is not installed at the expected location.'
            }
            $dockerAttemptStarted = Get-Date
            if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
                Write-LaunchEvent 'Starting Docker Desktop...'
                Start-Process -FilePath $DockerDesktop -WindowStyle Hidden
            }
            $dockerDeadline = (Get-Date).AddSeconds($DockerTimeoutSeconds)
            $firstDockerWait = [Math]::Min(45, $DockerTimeoutSeconds)
            $dockerReady = Wait-DockerReady -TimeoutSeconds $firstDockerWait
            $repairAttempts = 0
            while (-not $dockerReady -and (Get-Date) -lt $dockerDeadline) {
                if ($repairAttempts -lt 5) {
                    $repaired = Repair-StaleDockerRuntimeSocket -NotOlderThan $dockerAttemptStarted
                    if ($repaired) { $repairAttempts += 1 }
                }
                $remainingSeconds = [Math]::Max(1, [int](($dockerDeadline - (Get-Date)).TotalSeconds))
                $repairWait = [Math]::Min(15, $remainingSeconds)
                $dockerReady = Wait-DockerReady -TimeoutSeconds $repairWait
            }
            if (-not $dockerReady) {
                throw "Docker Desktop did not become ready within $DockerTimeoutSeconds seconds. Backend error: $(Get-DockerFailureSummary)"
            }
        }
        Write-LaunchEvent 'Docker Linux engine API is ready.' 'OK'

        $script:CurrentStage = 'runtime-configuration'
        Ensure-RuntimeComposeSettings
        $postgresPort = Get-RuntimeEnvValue -Key 'POSTGRES_PORT'
        $redisPort = Get-RuntimeEnvValue -Key 'REDIS_PORT'
        $grafanaPort = Get-RuntimeEnvValue -Key 'GRAFANA_PORT'
        if ($postgresPort -notmatch '^\d+$' -or [int]$postgresPort -lt 1 -or [int]$postgresPort -gt 65535) {
            throw "POSTGRES_PORT is invalid in $EnvFile."
        }
        if ($redisPort -notmatch '^\d+$' -or [int]$redisPort -lt 1 -or [int]$redisPort -gt 65535) {
            throw "REDIS_PORT is invalid in $EnvFile."
        }
        if ($grafanaPort -notmatch '^\d+$' -or [int]$grafanaPort -lt 1 -or [int]$grafanaPort -gt 65535) {
            throw "GRAFANA_PORT is invalid in $EnvFile."
        }
        Assert-DockerPortAvailableForJarvis -Port ([int]$postgresPort) -ExpectedContainer 'jarvis-postgres' -ServiceName 'PostgreSQL'
        Assert-DockerPortAvailableForJarvis -Port ([int]$redisPort) -ExpectedContainer 'jarvis-redis' -ServiceName 'Redis'
        Assert-DockerPortAvailableForJarvis -Port ([int]$grafanaPort) -ExpectedContainer 'jarvis-grafana' -ServiceName 'Grafana'
        Write-LaunchEvent "Runtime compose settings ready (PostgreSQL $postgresPort, Redis $redisPort, Grafana $grafanaPort; private data services loopback only)." 'OK'

        $script:CurrentStage = 'compose-validation'
        $validateArgs = @('compose', '-f', $ComposeFile, '--env-file', $EnvFile, 'config', '--quiet')
        Invoke-BoundedProcess -FilePath $DockerCli -ArgumentList $validateArgs -TimeoutSeconds 30 | Out-Null
        Write-LaunchEvent 'Compose configuration validated.' 'OK'

        $script:CurrentStage = 'infrastructure'
        $servicesForDiagnostics = @('postgres', 'redis', 'mosquitto')
        Invoke-ComposeUp -Services $servicesForDiagnostics
        Wait-ContainerState -ContainerName 'jarvis-postgres' -AcceptedStates @('healthy') -TimeoutSeconds 90 | Out-Null
        Wait-ContainerState -ContainerName 'jarvis-redis' -AcceptedStates @('running', 'healthy') -TimeoutSeconds 45 | Out-Null
        Wait-ContainerState -ContainerName 'jarvis-mosquitto' -AcceptedStates @('running', 'healthy') -TimeoutSeconds 45 | Out-Null
        Write-LaunchEvent 'PostgreSQL, Redis, and MQTT are ready.' 'OK'

        $script:CurrentStage = 'config-service'
        $servicesForDiagnostics = @('jarvis-config-service')
        Invoke-ComposeUp -Services $servicesForDiagnostics
        Wait-HttpReady -Name 'Config service' -Url 'http://127.0.0.1:7700/health' -TimeoutSeconds $ServiceTimeoutSeconds | Out-Null

        $script:CurrentStage = 'auth-service'
        $servicesForDiagnostics = @('jarvis-auth')
        Invoke-ComposeUp -Services $servicesForDiagnostics
        Wait-HttpReady -Name 'Auth service' -Url 'http://127.0.0.1:7701/health' -TimeoutSeconds $ServiceTimeoutSeconds | Out-Null

        $script:CurrentStage = 'command-center'
        $servicesForDiagnostics = @('jarvis-command-center')
        Invoke-ComposeUp -Services $servicesForDiagnostics
        Wait-HttpReady -Name 'Command Center' -Url 'http://127.0.0.1:7703/health' -TimeoutSeconds $ServiceTimeoutSeconds | Out-Null

        $script:CurrentStage = 'voice-services'
        $servicesForDiagnostics = @('jarvis-whisper-api', 'jarvis-tts')
        Invoke-ComposeUp -Services $servicesForDiagnostics
        Wait-HttpReady -Name 'Whisper STT' -Url 'http://127.0.0.1:7706/health' -TimeoutSeconds $ServiceTimeoutSeconds | Out-Null
        Wait-HttpReady -Name 'Text to speech' -Url 'http://127.0.0.1:7707/health' -TimeoutSeconds $ServiceTimeoutSeconds | Out-Null

        $script:CurrentStage = 'supporting-services'
        $servicesForDiagnostics = @('loki', 'jarvis-logs', 'jarvis-notifications', 'jarvis-settings-server', 'grafana')
        Invoke-ComposeUp -Services $servicesForDiagnostics
        Wait-HttpReady -Name 'Logs service' -Url 'http://127.0.0.1:7702/health' -TimeoutSeconds 90 | Out-Null
        Wait-HttpReady -Name 'Notifications service' -Url 'http://127.0.0.1:7712/health' -TimeoutSeconds 90 | Out-Null
        Wait-HttpReady -Name 'Settings service' -Url 'http://127.0.0.1:7708/health' -TimeoutSeconds 90 | Out-Null
        Wait-HttpReady -Name 'Grafana' -Url "http://127.0.0.1:$grafanaPort/api/health" -TimeoutSeconds 90 | Out-Null

        $proxyImage = 'ghcr.io/alexberardi/jarvis-llm-proxy-api:latest'
        if (Test-DockerImage -Image $proxyImage) {
            $script:CurrentStage = 'local-embedding-proxy'
            $servicesForDiagnostics = @('jarvis-llm-proxy-api', 'llm-proxy-worker')
            Invoke-ComposeUp -Services $servicesForDiagnostics
            Wait-HttpReady -Name 'Local embedding proxy' -Url 'http://127.0.0.1:7705/health' -TimeoutSeconds $ServiceTimeoutSeconds | Out-Null
        } else {
            Write-LaunchEvent 'Optional local embedding proxy image is not installed; native Qwen chat remains active.' 'WARN'
        }
    } else {
        $script:CurrentStage = 'degraded-mode'
        Write-LaunchEvent 'Docker startup was explicitly skipped; launching the native interface in degraded mode.' 'WARN'
    }

    $script:CurrentStage = 'dashboard'
    Ensure-AdminServer

    $script:CurrentStage = 'electron-ui'
    Start-NativeInterface

    $script:CurrentStage = 'complete'
    $finalStatus = if ($SkipDocker) { 'degraded' } else { 'ready' }
    if (-not $SkipDocker) { Mark-JarvisRuntimeReady }
    Write-StartupReport -Status $finalStatus -Message "Jarvis startup completed with status: $finalStatus."
    Write-LaunchEvent "Jarvis is ready: $UiUrl" 'OK'
} catch {
    $message = $_.Exception.Message
    Write-LaunchEvent $message 'ERROR'
    Add-ComposeDiagnosticsToLog -Services $servicesForDiagnostics
    Write-StartupReport -Status 'failed' -Message $message

    # Preserve Electron autostart even when a dependency is unavailable. The
    # dashboard remains useful for diagnostics and reports degraded services.
    try {
        $script:CurrentStage = 'dashboard-recovery'
        Ensure-AdminServer
        $script:CurrentStage = 'electron-recovery'
        Start-NativeInterface
    } catch {
        Write-LaunchEvent "Dashboard recovery also failed: $($_.Exception.Message)" 'ERROR'
    }
    exit 1
} finally {
    if ($ownsMutex) {
        try { $launcherMutex.ReleaseMutex() } catch {}
    }
    $launcherMutex.Dispose()
}
