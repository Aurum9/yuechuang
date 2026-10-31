[CmdletBinding()]
param(
    [switch] $RemoveCredentials,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'helper-common.ps1')
$root = Get-HelperRoot
$bin = Assert-HelperOwnedPath (Join-Path $root 'bin')
$manifestPath = Assert-HelperOwnedPath (Join-Path $root ($script:HelperHostName + '.json'))
$files = @(
    (Assert-HelperOwnedPath (Join-Path $bin 'yuechuang-helper.exe')),
    (Assert-HelperOwnedPath (Join-Path $bin 'helper-config.json')),
    $manifestPath
)
if ($RemoveCredentials) {
    $files += Assert-HelperOwnedPath (Join-Path $root 'credentials.bin')
    $files += Assert-HelperOwnedPath (Join-Path $root 'credentials.lock')
}

if ($DryRun) {
    [pscustomobject]@{
        RegistryPath = $script:HelperRegistryPath
        FilesToRemove = $files
        RemoveCredentials = [bool]$RemoveCredentials
        PreserveOtherFiles = $true
    } | ConvertTo-Json -Depth 4
    return
}

Assert-HelperStopped
foreach ($path in @($root, $bin) + $files) { Assert-HelperNoReparsePoint $path }
if (Test-Path -LiteralPath $script:HelperRegistryPath) {
    $existing = (Get-Item -LiteralPath $script:HelperRegistryPath).GetValue('')
    if (-not ([string]$existing).Equals($manifestPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The native host registry key points to another location. Nothing was removed.'
    }
    # Remove this exact application key; never recurse through the host namespace.
    Remove-Item -LiteralPath $script:HelperRegistryPath
}
foreach ($path in $files) {
    $checked = Assert-HelperOwnedPath $path
    if (Test-Path -LiteralPath $checked -PathType Leaf) { Remove-Item -LiteralPath $checked -Force }
}
foreach ($directory in @($bin, $root)) {
    $checked = Assert-HelperOwnedPath $directory -AllowRoot
    if ((Test-Path -LiteralPath $checked -PathType Container) -and @(Get-ChildItem -LiteralPath $checked -Force).Count -eq 0) {
        Remove-Item -LiteralPath $checked -Force
    }
}
if ($RemoveCredentials) {
    Write-Output 'Removed helper files, this application registry key, and local credentials. Remote authorization was not revoked by this script.'
} else {
    Write-Output 'Removed helper files and this application registry key. Local credentials were preserved; use -RemoveCredentials to delete them.'
}
