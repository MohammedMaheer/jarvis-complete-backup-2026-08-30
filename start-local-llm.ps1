param([int]$TimeoutSeconds = 120)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $ScriptDir 'bin\llama\llama-server.exe'
$Model = Join-Path $ScriptDir 'compose\.models\Qwen3-8B-Q4_K_M.gguf'
$LogDir = Join-Path $ScriptDir 'logs'
$HealthUrl = 'http://127.0.0.1:7704/health'

try {
    $ready = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
    if ($ready.status -eq 'ok') {
        Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | ForEach-Object {
            try { $_.PriorityClass = 'BelowNormal' } catch {}
        }
        return
    }
} catch {}

if (-not (Test-Path -LiteralPath $Server)) { throw "llama.cpp server is missing: $Server" }
if (-not (Test-Path -LiteralPath $Model)) { throw "Local Qwen model is missing: $Model" }

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$arguments = @(
    '--model', $Model,
    '--host', '127.0.0.1',
    '--port', '7704',
    '--ctx-size', '16384',
    '--gpu-layers', 'all',
    '--threads', '10',
    '--threads-batch', '16',
    '--batch-size', '1024',
    '--ubatch-size', '512',
    '--flash-attn', 'on',
    '--cache-type-k', 'q8_0',
    '--cache-type-v', 'q8_0',
    '--parallel', '1',
    '--reasoning', 'off',
    '--reasoning-budget', '0',
    '--metrics',
    '--no-webui'
)

$llamaProcess = Start-Process -FilePath $Server -ArgumentList $arguments -WorkingDirectory (Split-Path $Server -Parent) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogDir 'llm.out.log') -RedirectStandardError (Join-Path $LogDir 'llm.err.log') -PassThru
try { $llamaProcess.PriorityClass = 'BelowNormal' } catch {}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 3
        if ($health.status -eq 'ok') { return }
    } catch {}
} while ((Get-Date) -lt $deadline)

throw "Local Qwen model did not become ready within $TimeoutSeconds seconds."
