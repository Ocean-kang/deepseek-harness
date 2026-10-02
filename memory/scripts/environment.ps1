# Dot-source this file before a memory build, check, or supported dsh profile launch.
param([Parameter(Mandatory = $true)][string]$ProjectId)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ProjectId) -or $ProjectId.Trim() -ne $ProjectId) {
    throw 'ProjectId must be explicit and have no surrounding whitespace.'
}
$memoryTaskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$memoryCheckPath = $memoryTaskRoot
while ($memoryCheckPath) {
    if ((Get-Item -LiteralPath $memoryCheckPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing redirected memory root: $memoryCheckPath"
    }
    $memoryCheckPath = [IO.Path]::GetDirectoryName($memoryCheckPath)
}
foreach ($memoryDirectory in @('home', '.tmp', '.cache', '.artifacts', 'data')) {
    $memoryTarget = [IO.Path]::GetFullPath((Join-Path $memoryTaskRoot $memoryDirectory))
    if (-not $memoryTarget.StartsWith($memoryTaskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing out-of-root target: $memoryTarget"
    }
    if ((Test-Path -LiteralPath $memoryTarget) -and ((Get-Item -LiteralPath $memoryTarget -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing linked output directory: $memoryTarget"
    }
    [IO.Directory]::CreateDirectory($memoryTarget) | Out-Null
}
$env:DSH_HOME = Join-Path $memoryTaskRoot 'home'
$env:DSH_MEMORY_PROJECT = $ProjectId
$env:TMP = Join-Path $memoryTaskRoot '.tmp'
$env:TEMP = $env:TMP
$env:TMPDIR = $env:TMP
$env:XDG_CACHE_HOME = Join-Path $memoryTaskRoot '.cache'
$env:XDG_CONFIG_HOME = Join-Path $memoryTaskRoot 'home'
$env:XDG_DATA_HOME = Join-Path $memoryTaskRoot 'home'
$env:XDG_STATE_HOME = Join-Path $memoryTaskRoot 'home'
$env:npm_config_cache = Join-Path $memoryTaskRoot '.cache'
$env:NODE_COMPILE_CACHE = Join-Path $memoryTaskRoot '.cache'
$env:TSX_TSCONFIG_PATH = Join-Path $memoryTaskRoot 'tsconfig.host.json'
$env:DSH_TELEMETRY_DISABLED = '1'
Set-Location -LiteralPath $memoryTaskRoot
