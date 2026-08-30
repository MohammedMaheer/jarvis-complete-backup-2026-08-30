$ErrorActionPreference = 'Continue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFile = Join-Path $ScriptDir 'compose\docker-compose.yml'
$envFile = Join-Path $env:USERPROFILE '.jarvis\compose\.env'
docker compose -f $composeFile --env-file $envFile stop --timeout 0 2>$null | Out-Null

$listeners = Get-NetTCPConnection -LocalPort 7704,7711 -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
    $listeners | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
}

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        ($_.Name -eq 'electron.exe' -and $_.CommandLine -like '*source\jarvis-admin*') -or
        $_.Name -eq 'JARVIS Neural Interface.exe' -or
        $_.Name -eq 'JARVIS-Neural-Interface-0.0.0.exe'
    } |
    Select-Object -ExpandProperty ProcessId -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

Write-Host 'Jarvis is offline. Windows and unrelated applications were not changed.' -ForegroundColor Yellow
