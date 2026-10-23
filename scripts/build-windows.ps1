[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release',
    [string]$CoreDirectory = (Join-Path $PSScriptRoot '..\client\core'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\artifacts\windows'),
    [string]$GeositeSha256,
    [string]$GeoipSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows is required to build and validate this WPF package.'
}

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$core = [IO.Path]::GetFullPath($CoreDirectory)
$output = [IO.Path]::GetFullPath($OutputDirectory)
$requiredCore = @('sing-box.exe', 'geosite-cn.srs', 'geoip-cn.srs')
$requiredNotices = @('PACKAGE_README.txt', 'THIRD_PARTY_NOTICES.txt', 'LICENSE-sing-box.txt')
foreach ($name in $requiredCore) {
    $path = Join-Path $core $name
    if (!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
        throw "Missing or empty runtime dependency: $path. This snapshot contains source only; supply reviewed dependencies. See docs/BUILD_WINDOWS.md."
    }
}
foreach ($name in $requiredNotices) {
    if (!(Test-Path -LiteralPath (Join-Path $repo "client\$name") -PathType Leaf)) {
        throw "Required package notice missing: $name"
    }
}
$upstreamNotices = @('LICENSE-sing-box-upstream.txt', 'COPYING-GPL-3.0.txt')
foreach ($name in $upstreamNotices) {
    if (!(Test-Path -LiteralPath (Join-Path $repo "third_party\$name") -PathType Leaf)) {
        throw "Required upstream notice/license missing: third_party\$name"
    }
}
# Verify the supplied core without executing it or fetching a replacement.
$notices = Get-Content -LiteralPath (Join-Path $repo 'client\THIRD_PARTY_NOTICES.txt') -Raw
$hashMatch = [regex]::Match($notices, '(?m)^Binary SHA-256: ([A-Fa-f0-9]{64})\s*$')
if (!$hashMatch.Success) { throw 'THIRD_PARTY_NOTICES.txt must declare the reviewed sing-box SHA-256.' }
$coreHash = (Get-FileHash -LiteralPath (Join-Path $core 'sing-box.exe') -Algorithm SHA256).Hash
if ($coreHash -ne $hashMatch.Groups[1].Value) {
    throw 'The supplied sing-box executable does not match THIRD_PARTY_NOTICES.txt. Review dependency provenance before packaging.'
}
# Rule files were omitted from the snapshot. Require independently reviewed pins,
# not hashes silently derived from whichever files happen to be in the directory.
foreach ($rule in @(
    @{ Name = 'geosite-cn.srs'; Hash = $GeositeSha256 },
    @{ Name = 'geoip-cn.srs'; Hash = $GeoipSha256 }
)) {
    if ($rule.Hash -notmatch '^[A-Fa-f0-9]{64}$') {
        throw 'Reviewed rule-set SHA-256 pins are required. Supply -GeositeSha256 and -GeoipSha256; see docs/BUILD_WINDOWS.md.'
    }
    if ((Get-FileHash -LiteralPath (Join-Path $core $rule.Name) -Algorithm SHA256).Hash -ne $rule.Hash) {
        throw "Rule-set hash mismatch: $($rule.Name)"
    }
}
if (Test-Path -LiteralPath $output) {
    throw "Output already exists: $output. Select a new -OutputDirectory to avoid mixing stale or private files into a release."
}
if (!(Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '.NET SDK 10.0.402 is required; see global.json.' }

$work = Join-Path ([IO.Path]::GetTempPath()) ('CloudBridge-build-' + [guid]::NewGuid().ToString('N'))
$updaterOutput = Join-Path $work 'updater'
Push-Location -LiteralPath $repo
try {
    # Resolve the exact SDK using the repository's global.json, even when this
    # script was called by an absolute path from another working directory.
    $sdkVersion = & dotnet --version
    if ($LASTEXITCODE -ne 0 -or $sdkVersion.Trim() -ne '10.0.402') {
        throw '.NET SDK 10.0.402 is required; install the pinned SDK from global.json.'
    }
    & dotnet run --project (Join-Path $repo 'client\tests\CloudBridge.Configuration.Tests.csproj') -c $Configuration
    if ($LASTEXITCODE -ne 0) { throw 'Configuration/API behavior checks failed.' }
    # Always publish this source's updater first; never pick up an old optional binary.
    & dotnet publish (Join-Path $repo 'updater\CloudBridge.Updater.csproj') -c $Configuration -r win-x64 --self-contained true -o $updaterOutput '-p:ContinuousIntegrationBuild=true'
    if ($LASTEXITCODE -ne 0) { throw 'Updater publish failed.' }
    $updater = Join-Path $updaterOutput 'CloudBridge.Updater.exe'
    if (!(Test-Path -LiteralPath $updater -PathType Leaf)) { throw 'Updater publish did not produce CloudBridge.Updater.exe.' }

    & dotnet publish (Join-Path $repo 'client\CloudBridge.Client.csproj') -c $Configuration -r win-x64 --self-contained true -o $output "-p:CloudBridgeCoreDirectory=$core" "-p:CloudBridgeUpdaterPath=$updater" '-p:ContinuousIntegrationBuild=true'
    if ($LASTEXITCODE -ne 0) { throw "Client publish failed; do not distribute the incomplete output: $output" }
    $requiredPackage = @('壹色云桥.exe', 'CloudBridge.Updater.exe') + $requiredNotices + $upstreamNotices + ($requiredCore | ForEach-Object { "core\$_" })
    foreach ($name in $requiredPackage) {
        if (!(Test-Path -LiteralPath (Join-Path $output $name) -PathType Leaf)) {
            throw "Incomplete Windows package: $name"
        }
    }
    # Record hashes of every published file. This is not a signature or a reproducibility claim.
    Get-ChildItem -LiteralPath $output -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($output.TrimEnd('\').Length + 1).Replace('\', '/')
        '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
    } | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding UTF8
    Write-Output "Windows package published to: $output"
    Write-Output 'Build only: no client, updater, proxy core, device registration, or network-mode change was run.'
} finally {
    Pop-Location
    # Only the uniquely generated build scratch directory is removed.
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
