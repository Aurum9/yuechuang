[CmdletBinding()]
param([switch] $SkipBuild)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workspace = Split-Path -Parent $PSScriptRoot
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'helper-build.ps1')
}
$exe = Join-Path $workspace 'helper\bin\yuechuang-helper.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Build the helper before packaging.' }
$version = (Get-Content -LiteralPath (Join-Path $workspace 'public\manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Invalid extension version.' }
$releaseRoot = Join-Path $workspace 'helper-release'
[void][IO.Directory]::CreateDirectory($releaseRoot)
# Use a new staging directory, preserving previous packages and evidence.
$stage = Join-Path $releaseRoot ('yuechuang-helper-' + $version + '-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($stage)
Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'yuechuang-helper.exe')
foreach ($name in @('helper-common.ps1', 'helper-install.ps1', 'helper-uninstall.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $stage $name)
}
Copy-Item -LiteralPath (Join-Path $workspace 'docs\本地助手安装使用.md') -Destination (Join-Path $stage 'README.md')
Copy-Item -LiteralPath (Join-Path $workspace 'LICENSE') -Destination (Join-Path $stage 'LICENSE')
$checksums = @(Get-ChildItem -LiteralPath $stage -File | Sort-Object Name | ForEach-Object {
    [ordered]@{ file = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
[IO.File]::WriteAllText((Join-Path $stage 'checksums.json'), ($checksums | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
$zip = $stage + '.zip'
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $stage -File).FullName -DestinationPath $zip -CompressionLevel Optimal
$deliveryRoot = Join-Path $workspace 'release'
[void][IO.Directory]::CreateDirectory($deliveryRoot)
$deliveryZip = Join-Path $deliveryRoot ('yuechuang-helper-' + $version + '.zip')
# The versioned delivery copy may be refreshed; its unique archive is retained.
# Other versions and extension release ZIPs have different names and are untouched.
Copy-Item -LiteralPath $zip -Destination $deliveryZip -Force
$zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ((Get-FileHash -LiteralPath $deliveryZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $zipHash) { throw 'Delivery copy checksum mismatch.' }
[pscustomobject]@{ Version = $version; Package = $deliveryZip; ArchivePackage = $zip; Sha256 = $zipHash; Files = $checksums } | ConvertTo-Json -Depth 5
