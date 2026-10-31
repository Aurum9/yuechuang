[CmdletBinding()]
param(
    [string] $GoPath,
    [switch] $SkipTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workspace = Split-Path -Parent $PSScriptRoot
$helperRoot = Join-Path $workspace 'helper'
if ([string]::IsNullOrWhiteSpace($GoPath)) {
    $goCommand = Get-Command 'go.exe' -ErrorAction SilentlyContinue
    if ($goCommand) { $GoPath = $goCommand.Source }
    elseif (Test-Path -LiteralPath 'C:\Program Files\Go\bin\go.exe') { $GoPath = 'C:\Program Files\Go\bin\go.exe' }
    else { throw 'Install Go, or provide -GoPath with the path to go.exe.' }
}
if (-not (Test-Path -LiteralPath $GoPath -PathType Leaf)) { throw 'GoPath does not exist.' }
$outputDirectory = Join-Path $helperRoot 'bin'
$cacheDirectory = Join-Path $helperRoot '.gocache'
$tempDirectory = Join-Path $helperRoot '.gotmp'
foreach ($directory in @($outputDirectory, $cacheDirectory, $tempDirectory)) { [void][IO.Directory]::CreateDirectory($directory) }
$envNames = @('GOCACHE', 'GOTMPDIR', 'GOPROXY', 'GOSUMDB', 'GOTOOLCHAIN', 'GOOS', 'GOARCH', 'CGO_ENABLED')
$previous = @{}
foreach ($name in $envNames) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:GOCACHE = $cacheDirectory
    $env:GOTMPDIR = $tempDirectory
    $env:GOPROXY = 'off'
    $env:GOSUMDB = 'off'
    $env:GOTOOLCHAIN = 'local'
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    Push-Location -LiteralPath $helperRoot
    try {
        if (-not $SkipTests) {
            & $GoPath test './...'
            if ($LASTEXITCODE -ne 0) { throw 'Helper tests failed.' }
        }
        $exe = Join-Path $outputDirectory 'yuechuang-helper.exe'
        & $GoPath build '-trimpath' '-ldflags=-s -w' '-o' $exe '.'
        if ($LASTEXITCODE -ne 0) { throw 'Helper build failed.' }
        $file = Get-Item -LiteralPath $exe
        [pscustomobject]@{ Exe = $exe; Bytes = $file.Length; Sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json
    } finally { Pop-Location }
} finally {
    foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
