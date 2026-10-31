[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'helper-common.ps1')
$workspace = Split-Path -Parent $PSScriptRoot
$testRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'test-results\helper-installer-smoke'))
[void][IO.Directory]::CreateDirectory($testRoot)
$fixture = Join-Path $testRoot ([Guid]::NewGuid().ToString('N') + '.exe')
# This deliberately tiny fixture is for planning only; it is never installed.
[IO.File]::WriteAllBytes($fixture, [byte[]]@(77, 90, 0, 0))
$checks = 0
function Assert-Smoke([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw ('Smoke test failed: ' + $Message) }
    $script:checks += 1
}
function Assert-Throws([scriptblock] $Action, [string] $Message) {
    $thrown = $false
    try { & $Action | Out-Null } catch { $thrown = $true }
    Assert-Smoke $thrown $Message
}
try {
    foreach ($name in @('helper-common.ps1', 'helper-install.ps1', 'helper-uninstall.ps1', 'helper-build.ps1', 'helper-package.ps1')) {
        $tokens = $null
        $errors = $null
        [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$errors)
        Assert-Smoke ($errors.Count -eq 0) ($name + ' parses')
    }
    $extensionId = 'abcdefghijklmnopabcdefghijklmnop'
    $plan = (& (Join-Path $PSScriptRoot 'helper-install.ps1') -ExtensionId $extensionId -ExePath $fixture -DryRun) | ConvertFrom-Json
    Assert-Smoke ($plan.Manifest.name -eq 'com.yuechuang.helper') 'fixed host name'
    Assert-Smoke ($plan.Manifest.allowed_origins.Count -eq 1) 'single origin'
    Assert-Smoke ($plan.Manifest.allowed_origins[0] -eq ('chrome-extension://' + $extensionId + '/')) 'exact origin'
    Assert-Smoke ($plan.Manifest.path -eq (Join-Path (Get-HelperRoot) 'bin\yuechuang-helper.exe')) 'known helper path'
    Assert-Smoke ($plan.Config.allowedOrigins[0] -eq $plan.Manifest.allowed_origins[0]) 'helper and Chrome origin agree'
    Assert-Smoke ($plan.RegistryPath -eq 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.yuechuang.helper') 'current-user own registry key'
    foreach ($invalidId in @('', ('a' * 31), ('q' * 32), ('A' * 32), ('a' * 32 + '/'), '../abcdefghijklmnopabcdefghijklmnop')) {
        Assert-Throws { Assert-HelperExtensionId $invalidId } 'reject malformed extension ID'
    }
    Assert-Throws { Assert-HelperOwnedPath (Join-Path (Get-HelperRoot) '..\unrelated') } 'reject traversal'
    Assert-Throws { Assert-HelperOwnedPath ((Get-HelperRoot) + '-other\file') } 'reject sibling with same prefix'
    Assert-Throws { Assert-HelperOwnedPath (Get-HelperRoot) } 'root must be explicit'
    $uninstall = (& (Join-Path $PSScriptRoot 'helper-uninstall.ps1') -DryRun) | ConvertFrom-Json
    Assert-Smoke (-not $uninstall.RemoveCredentials) 'credentials retained by default'
    Assert-Smoke (@($uninstall.FilesToRemove | Where-Object { $_ -match 'credentials\.' }).Count -eq 0) 'default deletion list excludes credentials'
    $clear = (& (Join-Path $PSScriptRoot 'helper-uninstall.ps1') -RemoveCredentials -DryRun) | ConvertFrom-Json
    Assert-Smoke ($clear.RemoveCredentials -and @($clear.FilesToRemove | Where-Object { $_ -match 'credentials\.bin$' }).Count -eq 1) 'credential deletion requires explicit switch'
    [IO.File]::WriteAllBytes($fixture, [byte[]]@(0, 0, 0, 0))
    Assert-Throws { Get-HelperInstallPlan $extensionId $fixture } 'reject non-executable source'
    Write-Output ('Passed ' + $checks + ' installer checks. No installation, registry edits, credentials, login, or network access occurred.')
} finally {
    $absoluteFixture = [IO.Path]::GetFullPath($fixture)
    if (-not $absoluteFixture.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected smoke fixture path.' }
    if (Test-Path -LiteralPath $absoluteFixture -PathType Leaf) { Remove-Item -LiteralPath $absoluteFixture -Force }
}
