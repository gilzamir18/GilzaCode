# GilzaCode uninstaller (adapted from GilzaBots' uninstall.ps1).
# Application files are removed by default. Global data (~/.gilzacode, or
# GILZACODE_HOME) is removed only with -Purge, after confirmation. Project
# folders are never touched.
param(
    [switch]$Purge,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "GilzaCode"
$registryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GilzaCode"
$purgeDataDir = $null

# Run from "Installed apps" or the Start menu, this script owns a console window
# that closes the moment it ends, so a failure that only throws vanishes unread.
# Every failure goes to a log and, unless -Yes asked for an unattended run, stays
# on screen until dismissed.
$logPath = Join-Path $env:TEMP "GilzaCode-uninstall.log"
function Stop-Uninstall {
    param([Parameter(Mandatory = $true)][string]$Message)
    try { "[$(Get-Date -Format o)] $Message" | Out-File -FilePath $logPath -Append -Encoding utf8 } catch { }
    Write-Host ""
    Write-Host $Message -ForegroundColor Red
    Write-Host "Details were saved to $logPath" -ForegroundColor Yellow
    if (-not $Yes) {
        try { Read-Host "Press Enter to close this window" | Out-Null } catch { }
    }
    exit 1
}
trap { Stop-Uninstall "The uninstaller failed: $($_.Exception.Message)" }

function Get-DataDir {
    $dataDir = $env:GILZACODE_HOME
    if (-not $dataDir) { $dataDir = Join-Path $HOME ".gilzacode" }
    return $dataDir
}

# Resolve and confirm the destructive target before changing anything, so a
# rejected or unsafe purge cannot leave a half-uninstalled application.
if ($Purge) {
    $dataDir = Get-DataDir
    if (-not [IO.Path]::IsPathRooted($dataDir)) { Stop-Uninstall "Refusing to purge a relative data directory: $dataDir" }
    $purgeDataDir = [IO.Path]::GetFullPath($dataDir).TrimEnd('\')
    $unsafe = @([IO.Path]::GetPathRoot($purgeDataDir).TrimEnd('\'), [IO.Path]::GetFullPath($HOME).TrimEnd('\'))
    if ($unsafe | Where-Object { $_ -ieq $purgeDataDir }) { Stop-Uninstall "Refusing to purge unsafe data directory: $purgeDataDir" }
    if (-not $Yes) {
        $confirmation = Read-Host "Remove all GilzaCode global data at '$purgeDataDir'? Type 'remove' to continue"
        if ($confirmation -cne "remove") {
            Write-Host "Global data will be preserved."
            $Purge = $false
            $purgeDataDir = $null
        }
    }
}

# Anything started from the installation keeps its files locked: the window,
# the MCP bridge Claude Code runs, Tectonic, pandoc, winpty-agent.
$installPrefix = $installDir.TrimEnd('\') + '\'
$locking = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)
})
if ($locking.Count -gt 0) {
    $names = ($locking | ForEach-Object { "$($_.ProcessName) (PID $($_.Id))" }) -join ", "
    Stop-Uninstall "Programs started from the GilzaCode folder are still running: $names. Close GilzaCode (and any Claude Code session it started) and run the uninstaller again."
}

# Windows cannot remove a process's current directory; leave it first.
# Set-Location moves only PowerShell's location, so the process directory too.
Set-Location $env:TEMP
[Environment]::CurrentDirectory = $env:TEMP

Write-Host "Uninstalling GilzaCode..." -ForegroundColor Cyan

# Application files first. If they cannot all be removed, stop here with the
# shortcuts and the Installed-apps entry intact, so the installation stays
# visible and can be uninstalled again; nothing is purged for an uninstall that
# did not happen. A file briefly held by an antivirus scan is retried.
if (Test-Path $installDir) {
    $removeError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Remove-Item -Recurse -Force $installDir
            $removeError = $null
            break
        } catch {
            $removeError = $_
            Start-Sleep -Seconds 2
        }
    }
    if ($removeError -and (Test-Path $installDir)) {
        Stop-Uninstall "Could not remove $installDir ($($removeError.Exception.Message)). Close any program using files in that folder and run the uninstaller again, or delete the folder manually."
    }
}

# Only shortcuts that point at this installation are removed.
$wshShell = New-Object -ComObject WScript.Shell
$appExe = Join-Path $installDir "GilzaCode\GilzaCode.exe"
$uninstallers = @((Join-Path $installDir "GilzaCode\uninstall.ps1"), (Join-Path $installDir "GilzaCode\_internal\uninstall.ps1"))
foreach ($shortcutPath in @(
    (Join-Path $wshShell.SpecialFolders("Desktop") "GilzaCode.lnk"),
    (Join-Path $wshShell.SpecialFolders("Programs") "GilzaCode.lnk"),
    (Join-Path $wshShell.SpecialFolders("Programs") "Uninstall GilzaCode.lnk")
)) {
    if (-not (Test-Path $shortcutPath)) { continue }
    $shortcut = $wshShell.CreateShortcut($shortcutPath)
    $isApp = $shortcut.TargetPath -ieq $appExe
    $arguments = $shortcut.Arguments
    $isUninstall = [bool]($uninstallers | Where-Object { $arguments -and $arguments.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($isApp -or $isUninstall) { Remove-Item -Force $shortcutPath }
}

if (Test-Path $registryPath) { Remove-Item -Recurse -Force $registryPath }

if ($Purge) {
    if (Test-Path $purgeDataDir) { Remove-Item -Recurse -Force $purgeDataDir }
    Write-Host "Removed global data at $purgeDataDir. Project folders were preserved."
}

Write-Host "GilzaCode was removed." -ForegroundColor Green
if (-not $Purge) {
    Write-Host "Settings, the project list and downloaded voices are kept in $(Get-DataDir); delete that folder to remove them too. Project folders were not touched."
}
if (-not $Yes) {
    try { Read-Host "Press Enter to close this window" | Out-Null } catch { }
}
