# Check Jarvis Status & Health
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "         Jarvis Stack Health Check       " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

$services = @(
    @{ Name = "Admin Dashboard"; Port = 7711; Url = "http://127.0.0.1:7711/health" },
    @{ Name = "Config Service"; Port = 7700; Url = "http://127.0.0.1:7700/health" },
    @{ Name = "Auth & Accounts"; Port = 7701; Url = "http://127.0.0.1:7701/health" },
    @{ Name = "Command Center"; Port = 7703; Url = "http://127.0.0.1:7703/health" },
    @{ Name = "Whisper STT"; Port = 7706; Url = "http://127.0.0.1:7706/health" },
    @{ Name = "TTS (Kokoro/Piper)"; Port = 7707; Url = "http://127.0.0.1:7707/health" },
    @{ Name = "Settings Server"; Port = 7708; Url = "http://127.0.0.1:7708/health" },
    @{ Name = "Logs Aggregator"; Port = 7702; Url = "http://127.0.0.1:7702/health" },
    @{ Name = "Notifications"; Port = 7712; Url = "http://127.0.0.1:7712/health" },
    @{ Name = "Grafana Dashboard"; Port = 3001; Url = "http://127.0.0.1:3001/api/health" }
)

foreach ($svc in $services) {
    try {
        $resp = Invoke-WebRequest -Uri $svc.Url -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        Write-Host ("[{0}] OK ({1})" -f $svc.Name, $svc.Url) -ForegroundColor Green
    } catch {
        Write-Host ("[{0}] Unreachable / Down ({1})" -f $svc.Name, $svc.Url) -ForegroundColor Red
    }
}

Write-Host "`nDocker Containers:" -ForegroundColor Yellow
docker ps --filter "name=jarvis-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
