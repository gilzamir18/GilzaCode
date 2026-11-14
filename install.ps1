# =========================================================
# GilzaCode installer for Windows (per user, no administrator rights).
#
#   From a local build:  powershell -ExecutionPolicy Bypass -File install.ps1 -Source dist\GilzaCode-windows-x64.zip
#   From a URL:          $env:GILZACODE_DOWNLOAD_URL = "https://.../GilzaCode-windows-x64.zip"; irm <install.ps1 url> | iex
#   Latest release:      irm https://raw.githubusercontent.com/gilzamir18/GilzaCode/HEAD/install.ps1 | iex
#
# Adapted from GilzaBots' install.ps1. GilzaCode is free; besides Windows, the
# only thing it needs is Claude Code (`claude` on PATH).
# =========================================================
param(
    [string]$Source = ""
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "           GilzaCode Installer            " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$installDir = Join-Path $env:LOCALAPPDATA "GilzaCode"
$assetName = "GilzaCode-windows-x64.zip"
$repoOwner = "gilzamir18"
$repoName = "GilzaCode"
$headers = @{
    "Accept"               = "application/vnd.github+json"
    "User-Agent"           = "GilzaCode-Installer"
    "X-GitHub-Api-Version" = "2022-11-28"
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$webView2DownloadUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
$releaseTag = ""

# Same registry keys as gilzacode/window/webview2.py (and pywebview).
function Test-WebView2Runtime {
    $clients = @(
        "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "{2CD8A007-E189-409D-A2C8-9AF4EF3C72AA}",
        "{0D50BFEC-CD6A-4F9A-964C-C7416E3ACB10}",
        "{65C35B14-6C1D-4122-AC46-7148CC9D6497}"
    )
    $minimum = [Version]"86.0.622.0"
    foreach ($client in $clients) {
        foreach ($path in @(
            "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$client",
            "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$client"
        )) {
            $pv = (Get-ItemProperty -Path $path -Name "pv" -ErrorAction SilentlyContinue).pv
            $version = $null
            if ($pv -and [Version]::TryParse($pv, [ref]$version) -and $version -ge $minimum) {
                return $true
            }
        }
    }
    return $false
}

function Test-GilzaCodeRunning {
    param([Parameter(Mandatory = $true)][string]$Directory)
    # Extracting over a running copy fails on its locked executables partway
    # through, leaving a mix of old and new files behind.
    $prefix = $Directory.TrimEnd('\') + '\'
    $running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    }
    return [bool]$running
}

function Invoke-Download {
    param([Parameter(Mandatory = $true)][string]$Uri, [Parameter(Mandatory = $true)][string]$OutFile)
    # Windows PowerShell 5.1 redraws its progress bar per chunk, which makes a
    # download this size many times slower; silenced in this scope only.
    $ProgressPreference = "SilentlyContinue"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            if (Test-Path $OutFile) { Remove-Item -Path $OutFile -Force }
            Invoke-WebRequest -Uri $Uri -OutFile $OutFile -Headers $headers -UseBasicParsing -MaximumRedirection 10
            if ((Test-Path $OutFile) -and ((Get-Item $OutFile).Length -gt 0)) { return }
            throw "The download completed but the file is empty."
        } catch {
            if ($attempt -eq 3) { throw "Failed to download GilzaCode after 3 attempts. Last error: $($_.Exception.Message)" }
            Write-Host "Download failed. Retrying ($attempt/3)..." -ForegroundColor Yellow
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
}

# Where the package comes from: -Source (a .zip path or URL), then
# GILZACODE_DOWNLOAD_URL, then the latest GitHub release.
function Resolve-Package {
    $location = if ($Source) { $Source } elseif ($env:GILZACODE_DOWNLOAD_URL) { $env:GILZACODE_DOWNLOAD_URL } else { "" }
    if ($location -and (Test-Path $location)) {
        return @{ Path = (Resolve-Path $location).Path; Downloaded = $false }
    }
    if (-not $location) {
        Write-Host "Checking the latest GitHub release ($repoOwner/$repoName)..." -ForegroundColor Yellow
        try {
            $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoOwner/$repoName/releases/latest" -Headers $headers
        } catch {
            throw "No GilzaCode release could be found on GitHub ($repoOwner/$repoName). Build one with build_exe.ps1 and run: install.ps1 -Source dist\$assetName"
        }
        $script:releaseTag = ($release.tag_name -replace '^v', '')
        $asset = $release.assets | Where-Object { $_.name -eq $assetName -and $_.state -eq "uploaded" } | Select-Object -First 1
        if (-not $asset) { throw "The latest GitHub release has no $assetName." }
        $location = $asset.browser_download_url
    }
    if ($location -notmatch '^https?://') { throw "The package '$location' is neither an existing file nor an http(s) URL." }
    $zip = Join-Path $env:TEMP "gilzacode_release.zip"
    Write-Host "Downloading GilzaCode from $location" -ForegroundColor Yellow
    Invoke-Download -Uri $location -OutFile $zip
    return @{ Path = $zip; Downloaded = $true }
}

if ((Test-Path $installDir) -and (Test-GilzaCodeRunning -Directory $installDir)) {
    throw "GilzaCode is running from $installDir. Close it and run the installer again."
}

$package = Resolve-Package
Write-Host "Extracting to $installDir (this can take a minute)..." -ForegroundColor Yellow
$appDir = Join-Path $installDir "GilzaCode"
if (Test-Path $appDir) {
    # A previous version's files would otherwise linger next to the new ones.
    Remove-Item -Recurse -Force $appDir
}
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
& {
    $ProgressPreference = "SilentlyContinue"
    Expand-Archive -Path $package.Path -DestinationPath $installDir -Force
}
if ($package.Downloaded) { Remove-Item -Path $package.Path -Force -ErrorAction SilentlyContinue }

$exePath = Join-Path $appDir "GilzaCode.exe"
foreach ($required in @($exePath, (Join-Path $appDir "gilzacode-mcp.exe"))) {
    if (-not (Test-Path $required)) { throw "The package is incomplete: $required is missing." }
}
# PyInstaller 6+ keeps data files in `_internal`; resolve both layouts.
$uninstallerPath = @((Join-Path $appDir "uninstall.ps1"), (Join-Path $appDir "_internal\uninstall.ps1")) |
    Where-Object { Test-Path $_ } | Select-Object -First 1
$appVersion = if ($script:releaseTag) { $script:releaseTag } else {
    (Get-Item $exePath).VersionInfo.ProductVersion
}
if (-not $appVersion) { $appVersion = "0.1.0" }

Write-Host "Creating Desktop and Start menu shortcuts..." -ForegroundColor Yellow
$wshShell = New-Object -ComObject WScript.Shell
$description = "GilzaCode: read and write with Claude Code"
foreach ($folder in @($wshShell.SpecialFolders("Desktop"), $wshShell.SpecialFolders("Programs"))) {
    if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
    $shortcut = $wshShell.CreateShortcut((Join-Path $folder "GilzaCode.lnk"))
    $shortcut.TargetPath = $exePath
    $shortcut.WorkingDirectory = $appDir
    $shortcut.Description = $description
    $shortcut.IconLocation = "$exePath,0"
    $shortcut.Save()
}

if ($uninstallerPath) {
    $programs = $wshShell.SpecialFolders("Programs")
    $uninstallShortcut = $wshShell.CreateShortcut((Join-Path $programs "Uninstall GilzaCode.lnk"))
    $uninstallShortcut.TargetPath = "powershell.exe"
    $uninstallShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$uninstallerPath`""
    $uninstallShortcut.WorkingDirectory = $env:TEMP
    $uninstallShortcut.Description = "Uninstall GilzaCode"
    $uninstallShortcut.Save()

    # A per-user entry in Settings > Apps > Installed apps, no administrator needed.
    $registryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GilzaCode"
    if (-not (Test-Path $registryPath)) { New-Item -Path $registryPath -Force | Out-Null }
    $uninstallCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$uninstallerPath`""
    Set-ItemProperty -Path $registryPath -Name "DisplayName" -Value "GilzaCode"
    Set-ItemProperty -Path $registryPath -Name "DisplayVersion" -Value $appVersion
    Set-ItemProperty -Path $registryPath -Name "Publisher" -Value "Gilzamir Gomes"
    Set-ItemProperty -Path $registryPath -Name "DisplayIcon" -Value $exePath
    Set-ItemProperty -Path $registryPath -Name "InstallLocation" -Value $installDir
    Set-ItemProperty -Path $registryPath -Name "UninstallString" -Value $uninstallCommand
    Set-ItemProperty -Path $registryPath -Name "NoModify" -Type DWord -Value 1
    Set-ItemProperty -Path $registryPath -Name "NoRepair" -Type DWord -Value 1
} else {
    Write-Warning "This package has no uninstall.ps1; to remove GilzaCode later, delete $installDir and its shortcuts."
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "      GilzaCode installed successfully!   " -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host "Start it from the Desktop or the Start menu." -ForegroundColor Cyan
Write-Host "To uninstall, use Settings > Apps > Installed apps, or the Start menu shortcut." -ForegroundColor Cyan

# What GilzaCode needs and does not install for the user.
if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and
    -not (Test-Path (Join-Path $env:USERPROFILE ".local\bin\claude.exe"))) {
    Write-Host ""
    Write-Warning "Claude Code (claude) was not found. GilzaCode needs it for its Claude Code panel, Translate and Look up."
    Write-Host "GilzaCode needs the Claude Code CLI (the claude command), not the Claude desktop app. Install it with:" -ForegroundColor Yellow
    Write-Host "    irm https://claude.ai/install.ps1 | iex" -ForegroundColor Yellow
    Write-Host "or from GilzaCode's Settings > Dependencies. Guide: https://code.claude.com/docs/en/setup" -ForegroundColor Yellow
}
if (-not (Test-WebView2Runtime)) {
    Write-Host ""
    Write-Warning "Microsoft Edge WebView2 Runtime was not found. The GilzaCode window needs it."
    Write-Host "Install it from $webView2DownloadUrl and start GilzaCode again." -ForegroundColor Yellow
}
