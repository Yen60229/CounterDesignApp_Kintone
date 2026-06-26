# build.ps1 - Auto-Numbering Plugin (SYS-07-2)
# Usage:
#   .\build.ps1            - sync mobile.js + pack (version unchanged)
#   .\build.ps1 1.2.0      - sync + bump version to 1.2.0 + pack

param([string]$Version = '')

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "=== Auto-Numbering Plugin (SYS-07-2) Build ===" -ForegroundColor Cyan

# helper: extract version from manifest.json via regex (avoids ConvertFrom-Json encoding issues)
function Get-ManifestVersion {
    $raw = Get-Content "$PSScriptRoot\contents\manifest.json" -Raw -Encoding utf8
    if ($raw -match '"version":\s*"([^"]+)"') { return $Matches[1] }
    return '0.0.0'
}

# 1. Sync mobile.js = desktop.js
Copy-Item contents\dist\desktop.js contents\dist\mobile.js -Force
Write-Host "[1/4] mobile.js synced" -ForegroundColor Green

# 2. Version bump (optional)
if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        Write-Error "Version format must be x.y.z (e.g. 1.2.0)"; exit 1
    }

    $manifest = Get-Content contents\manifest.json -Raw -Encoding utf8
    $manifest = $manifest -replace '"version":\s*"[^"]+"', ('"version": "' + $Version + '"')
    [System.IO.File]::WriteAllText("$PSScriptRoot\contents\manifest.json", $manifest, [System.Text.Encoding]::UTF8)

    $cfg = Get-Content contents\dist\config.js -Raw -Encoding utf8
    $cfg = $cfg -replace "const UI_VERSION = '[^']+'", ("const UI_VERSION = '" + $Version + "'")
    [System.IO.File]::WriteAllText("$PSScriptRoot\contents\dist\config.js", $cfg, [System.Text.Encoding]::UTF8)

    Copy-Item contents\dist\desktop.js contents\dist\mobile.js -Force

    Write-Host "[2/4] Version bumped to $Version (manifest.json + config.js UI_VERSION)" -ForegroundColor Green
} else {
    $currentVer = Get-ManifestVersion
    Write-Host "[2/4] Version unchanged: $currentVer" -ForegroundColor Gray
}

# 3. Find .ppk
$ppk = Get-ChildItem "$PSScriptRoot\*.ppk" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $ppk) {
    Write-Error ".ppk key not found in $PSScriptRoot"; exit 1
}
Write-Host "[3/4] Using key: $($ppk.Name)" -ForegroundColor Green

# 4. Pack
$ver = Get-ManifestVersion
$out = "plugin_v$ver.zip"

Write-Host "[4/4] Packing..." -ForegroundColor Cyan
npx @kintone/plugin-packer contents --ppk $ppk.Name --out $out

if (Test-Path $out) {
    $size = (Get-Item $out).Length
    Write-Host ""
    Write-Host "=== Done ===" -ForegroundColor Cyan
    Write-Host "Output: $out ($size bytes)" -ForegroundColor Green
    Write-Host "Next: kintone admin > Plugin > Update > upload $out" -ForegroundColor Yellow
} else {
    Write-Error "Pack failed, $out not found"
}