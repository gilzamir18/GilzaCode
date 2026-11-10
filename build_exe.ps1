# Builds the Windows package: dist\GilzaCode\ (GilzaCode.exe + gilzacode-mcp.exe)
# and dist\GilzaCode-windows-x64.zip, which install.ps1 installs.
#
#   powershell -ExecutionPolicy Bypass -File build_exe.ps1
#
# Uses .venv when present. Tectonic and pandoc are bundled (bin\), as in
# GilzaBots, so LaTeX and DOCX export work without a first-run download.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "=========================================="
Write-Host "        GilzaCode - Windows build         "
Write-Host "=========================================="

$venvScripts = Join-Path $PSScriptRoot ".venv\Scripts"
if (Test-Path (Join-Path $venvScripts "python.exe")) {
    Write-Host "[env] Using the virtual environment in $venvScripts"
    $env:PATH = "$venvScripts;$env:PATH"
}

function Invoke-Checked {
    param([Parameter(Mandatory = $true)][scriptblock]$Command, [Parameter(Mandatory = $true)][string]$What)
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}

function Get-ToolArchive {
    param([string]$Url, [string]$Archive)
    $ProgressPreference = "SilentlyContinue"
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing
}

Write-Host "`n[1/5] Python dependencies"
Invoke-Checked { python -m pip install --quiet pyinstaller } "pip install pyinstaller"
Invoke-Checked { python -m pip install --quiet -e . } "pip install -e ."   # editable: the spec reads the sources from this folder

Write-Host "`n[2/5] Interface (gui/)"
Push-Location gui
try {
    Invoke-Checked { npm ci --no-audit --no-fund } "npm ci"
    Invoke-Checked { npm run build } "npm run build"
} finally {
    Pop-Location
}
if (-not (Test-Path "gilzacode\static\index.html")) { throw "The interface build produced no gilzacode\static\index.html." }

Write-Host "`n[3/5] Bundled tools (Tectonic, pandoc)"
$tools = Join-Path $PSScriptRoot "build\tools\bin"
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$downloads = Join-Path $PSScriptRoot "build\tools\downloads"
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
if (-not (Test-Path (Join-Path $tools "tectonic.exe"))) {
    $archive = Join-Path $downloads "tectonic.zip"
    Get-ToolArchive "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-pc-windows-msvc.zip" $archive
    Expand-Archive -Path $archive -DestinationPath $tools -Force
}
if (-not (Test-Path (Join-Path $tools "pandoc.exe"))) {
    $pandocVersion = "3.10"
    $archive = Join-Path $downloads "pandoc.zip"
    Get-ToolArchive "https://github.com/jgm/pandoc/releases/download/$pandocVersion/pandoc-$pandocVersion-windows-x86_64.zip" $archive
    $extract = Join-Path $downloads "pandoc"
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive -Path $archive -DestinationPath $extract -Force
    $pandoc = Get-ChildItem -Path $extract -Recurse -Filter "pandoc.exe" | Select-Object -First 1
    if (-not $pandoc) { throw "pandoc.exe was not found in the downloaded archive." }
    Copy-Item -Path $pandoc.FullName -Destination (Join-Path $tools "pandoc.exe") -Force
}
foreach ($tool in @("tectonic.exe", "pandoc.exe")) {
    if (-not (Test-Path (Join-Path $tools $tool))) { throw "$tool is missing from $tools." }
}

Write-Host "`n[3.5/5] Google OAuth client for Cloud sync"
# With GILZACODE_GDRIVE_CLIENT_ID/_SECRET set, the build embeds the client and
# "Connect with Google" is one click. Without them the app still works, and a
# client injected earlier (the git-ignored file exists) is embedded as is.
if ($env:GILZACODE_GDRIVE_CLIENT_ID) {
    Invoke-Checked { python scripts\embed_google_client.py --from-env } "embed_google_client.py"
}
if (Test-Path "gilzacode\cloud\providers\bundled_google_client.json") {
    Write-Host "The Google OAuth client is embedded."
} else {
    Write-Warning "No Google OAuth client: Cloud sync in this build needs a user-supplied client."
}

Write-Host "`n[4/5] PyInstaller"
Invoke-Checked {
    python -m PyInstaller packaging\GilzaCode.spec --noconfirm --clean --distpath dist --workpath build\pyinstaller
} "PyInstaller"
$bundle = Join-Path $PSScriptRoot "dist\GilzaCode"
foreach ($exe in @("GilzaCode.exe", "gilzacode-mcp.exe")) {
    if (-not (Test-Path (Join-Path $bundle $exe))) { throw "$exe is missing from $bundle." }
}

# The bridge is what Claude Code starts; a build whose bridge cannot answer
# `initialize` over stdio is not shipped.
$probe = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}'
$answer = $probe | & (Join-Path $bundle "gilzacode-mcp.exe")
if ($LASTEXITCODE -ne 0 -or -not ($answer -match '"protocolVersion"\s*:\s*"2025-11-25"')) {
    throw "The bundled gilzacode-mcp.exe did not answer initialize. Output: $answer"
}
Write-Host "Bundled bridge answers initialize."

Write-Host "`n[5/5] Release archive"
$zip = Join-Path $PSScriptRoot "dist\GilzaCode-windows-x64.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
& {
    $ProgressPreference = "SilentlyContinue"
    Compress-Archive -Path $bundle -DestinationPath $zip -Force
}

$sizeMB = [math]::Round((Get-Item $zip).Length / 1MB)
Write-Host "`n=========================================="
Write-Host "Build finished."
Write-Host "  Folder:  $bundle"
Write-Host "  Archive: $zip ($sizeMB MB)"
Write-Host "  Install: powershell -ExecutionPolicy Bypass -File install.ps1 -Source `"$zip`""
Write-Host "=========================================="
