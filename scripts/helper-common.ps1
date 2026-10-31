Set-StrictMode -Version Latest

$script:HelperHostName = 'com.yuechuang.helper'
$script:HelperRegistryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.yuechuang.helper'

function Get-HelperDefaultExe {
    $bundled = Join-Path $PSScriptRoot 'yuechuang-helper.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    return Join-Path (Split-Path -Parent $PSScriptRoot) 'helper\bin\yuechuang-helper.exe'
}

function Assert-HelperExtensionId([string] $ExtensionId) {
    if ($ExtensionId -cnotmatch '^[a-p]{32}$') {
        throw 'ExtensionId must be the actual 32-character Chrome extension ID (letters a-p).'
    }
}

function Get-HelperRoot {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA is unavailable.' }
    return [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'YuechuangHelper'))
}

function Assert-HelperOwnedPath([string] $Path, [switch] $AllowRoot) {
    $root = (Get-HelperRoot).TrimEnd('\')
    $absolute = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $atRoot = $absolute.Equals($root, [StringComparison]::OrdinalIgnoreCase)
    $inside = $absolute.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
    if (-not $inside -and -not ($AllowRoot -and $atRoot)) {
        throw "Refusing path outside the owned install directory: $absolute"
    }
    return $absolute
}

function Assert-HelperNoReparsePoint([string] $Path) {
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to follow a reparse point: $Path"
        }
    }
}

function Get-HelperInstallPlan([string] $ExtensionId, [string] $ExePath) {
    Assert-HelperExtensionId $ExtensionId
    $source = [IO.Path]::GetFullPath($ExePath)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Build the helper first; executable missing: $source" }
    $stream = [IO.File]::OpenRead($source)
    try {
        if ($stream.ReadByte() -ne 77 -or $stream.ReadByte() -ne 90) { throw 'The helper source is not a Windows executable.' }
    } finally { $stream.Dispose() }
    $root = Get-HelperRoot
    $bin = Assert-HelperOwnedPath (Join-Path $root 'bin')
    $targetExe = Assert-HelperOwnedPath (Join-Path $bin 'yuechuang-helper.exe')
    $configPath = Assert-HelperOwnedPath (Join-Path $bin 'helper-config.json')
    $manifestPath = Assert-HelperOwnedPath (Join-Path $root ($script:HelperHostName + '.json'))
    $origin = 'chrome-extension://' + $ExtensionId + '/'
    $manifest = [ordered]@{
        name = $script:HelperHostName
        description = 'Yuechuang local ChatGPT sign-in helper'
        path = $targetExe
        type = 'stdio'
        allowed_origins = @($origin)
    }
    return [pscustomobject]@{
        InstallRoot = $root
        BinDirectory = $bin
        SourceExe = $source
        TargetExe = $targetExe
        ConfigPath = $configPath
        ManifestPath = $manifestPath
        RegistryPath = $script:HelperRegistryPath
        AllowedOrigin = $origin
        SourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
        Config = @{ allowedOrigins = @($origin) }
        Manifest = $manifest
    }
}

function Assert-HelperStopped {
    $expected = Join-Path (Get-HelperRoot) 'bin\yuechuang-helper.exe'
    foreach ($process in @(Get-Process -Name 'yuechuang-helper' -ErrorAction SilentlyContinue)) {
        if ($process.Path -and $process.Path.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Close the Yuechuang sidebar and finish or cancel sign-in before installing or uninstalling the helper.'
        }
    }
}

function Write-HelperUtf8([string] $Path, [string] $Content) {
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}
