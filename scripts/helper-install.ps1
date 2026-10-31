[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $ExtensionId,
    [string] $ExePath,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'helper-common.ps1')
if ([string]::IsNullOrWhiteSpace($ExePath)) { $ExePath = Get-HelperDefaultExe }
$plan = Get-HelperInstallPlan $ExtensionId $ExePath

# A dry run performs validation only, without filesystem or registry writes.
if ($DryRun) {
    $plan | ConvertTo-Json -Depth 6
    return
}

Assert-HelperStopped
foreach ($path in @($plan.InstallRoot, $plan.BinDirectory, $plan.TargetExe, $plan.ConfigPath, $plan.ManifestPath)) {
    Assert-HelperNoReparsePoint $path
}
if (Test-Path -LiteralPath $plan.RegistryPath) {
    $existing = (Get-Item -LiteralPath $plan.RegistryPath).GetValue('')
    if ($existing -and -not ([string]$existing).Equals($plan.ManifestPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The native host registry key points to a different installation. No files were changed.'
    }
}

[void][IO.Directory]::CreateDirectory($plan.BinDirectory)
# Known owned paths only. No recursive delete or process termination is used.
if (-not $plan.SourceExe.Equals($plan.TargetExe, [StringComparison]::OrdinalIgnoreCase)) {
    Copy-Item -LiteralPath $plan.SourceExe -Destination $plan.TargetExe -Force
}
Write-HelperUtf8 $plan.ConfigPath ($plan.Config | ConvertTo-Json -Depth 4)
Write-HelperUtf8 $plan.ManifestPath ($plan.Manifest | ConvertTo-Json -Depth 4)
$installedHash = (Get-FileHash -LiteralPath $plan.TargetExe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installedHash -ne $plan.SourceSha256) { throw 'Installed helper hash verification failed; the registry was not changed.' }
[void](New-Item -Path $plan.RegistryPath -Force)
Set-Item -LiteralPath $plan.RegistryPath -Value $plan.ManifestPath
Write-Output ('Installed for this Windows user. Allowed extension: ' + $ExtensionId)
Write-Output ('Helper: ' + $plan.TargetExe)
Write-Output 'Reload Yuechuang in Chrome, then open Settings > ChatGPT sign-in.'
