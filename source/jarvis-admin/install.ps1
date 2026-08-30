# Jarvis Admin Installer for Windows
# Usage: irm https://raw.githubusercontent.com/alexberardi/jarvis-admin/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$Repo = 'alexberardi/jarvis-admin'
$InstallDir = Join-Path $env:USERPROFILE '.jarvis\bin'
$BinaryName = 'jarvis-admin.exe'
$Artifact = 'jarvis-admin-windows-x64.exe'

function Write-Info($msg)    { Write-Host "> $msg" -ForegroundColor Blue }
function Write-Success($msg) { Write-Host "> $msg" -ForegroundColor Green }
function Write-Err($msg)     { Write-Host "> $msg" -ForegroundColor Red; exit 1 }

# Check prerequisites
function Test-Prerequisites {
    $dockerPath = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerPath) {
        Write-Host "Warning: Docker not found. Jarvis requires Docker Desktop to run services." -ForegroundColor Yellow
        Write-Host "  Install: https://www.docker.com/products/docker-desktop/" -ForegroundColor Yellow
        Write-Host ""
    }
}

# Get latest release tag
function Get-LatestVersion {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    if (-not $release.tag_name) {
        Write-Err "Could not determine latest version. Check https://github.com/$Repo/releases"
    }
    $version = $release.tag_name
    Write-Info "Latest version: $version"
    return $version
}

# Download and install binary + frontend assets
function Install-Binary($version) {
    $downloadUrl = "https://github.com/$Repo/releases/download/$version/$Artifact"
    $publicUrl = "https://github.com/$Repo/releases/download/$version/public.tar.gz"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    $binaryPath = Join-Path $InstallDir $BinaryName
    Write-Info "Downloading $Artifact..."
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $binaryPath -UseBasicParsing
    } catch {
        Write-Err "Download failed. Check if release exists: https://github.com/$Repo/releases/tag/$version"
    }
    Write-Success "Installed binary to $binaryPath"

    # Download frontend assets
    Write-Info "Downloading frontend assets..."
    $tarball = Join-Path $env:TEMP 'jarvis-public.tar.gz'
    try {
        Invoke-WebRequest -Uri $publicUrl -OutFile $tarball -UseBasicParsing
        # Extract using tar (available on Windows 10+)
        tar xzf $tarball -C $InstallDir
        Remove-Item $tarball -Force
        Write-Success "Frontend assets installed to $InstallDir\public\"
    } catch {
        Write-Err "Failed to download frontend assets"
    }
}

# Write installed version to admin.json
function Write-Version($version) {
    $configDir = Join-Path $env:USERPROFILE '.jarvis'
    $configFile = Join-Path $configDir 'admin.json'
    $semver = $version.TrimStart('v')

    New-Item -ItemType Directory -Force -Path $configDir | Out-Null

    if (Test-Path $configFile) {
        $config = Get-Content $configFile -Raw | ConvertFrom-Json
        $config | Add-Member -NotePropertyName 'installedVersion' -NotePropertyValue $semver -Force
    } else {
        $config = @{ installedVersion = $semver }
    }

    $config | ConvertTo-Json | Set-Content $configFile
}

# Add to user PATH if not already present
function Add-ToPath {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable('Path', "$InstallDir;$userPath", 'User')
        Write-Info "Added $InstallDir to user PATH"
    }
    $env:Path = "$InstallDir;$env:Path"
}

# Start the admin server
function Start-Admin {
    $binaryPath = Join-Path $InstallDir $BinaryName
    $publicDir = Join-Path $InstallDir 'public'
    $logDir = Join-Path $env:USERPROFILE '.jarvis\logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    $logFile = Join-Path $logDir 'admin.log'

    Write-Info "Starting jarvis-admin..."
    $proc = Start-Process -FilePath $binaryPath `
        -ArgumentList @() `
        -Environment @{ PORT = '7711'; STATIC_DIR = $publicDir } `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError $logFile `
        -PassThru -WindowStyle Hidden

    if ($proc) {
        Write-Success "Started (PID: $($proc.Id))"
    }
}

# Main
Write-Host ""
Write-Host "Jarvis Admin Installer" -ForegroundColor White
Write-Host ""

Test-Prerequisites

Write-Info "Platform: windows-x64"
$version = Get-LatestVersion
Install-Binary $version
Write-Version $version
Add-ToPath
Start-Admin

Write-Host ""
Write-Success "Jarvis Admin is running!"
Write-Host ""
Write-Host "  Open http://localhost:7711 in your browser to get started."
Write-Host ""
Write-Host "  To start manually: jarvis-admin.exe"
Write-Host "  Logs: $env:USERPROFILE\.jarvis\logs\admin.log"
Write-Host ""
