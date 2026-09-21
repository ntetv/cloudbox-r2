[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $RemainingArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PayloadRef = "d4082e36f6edb2bf61ece3a4dddd474c6dfd4ef9"
$PayloadSha256 = "bb576806ad5a05b85850bd3fae6a59632369d0216cf4013fcef84d779fc71b12"
$NodeVersion = "22.23.2"
$NodeArchive = "node-v22.23.2-win-x64.zip"
$NodeSha256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
$NodeUrl = "https://nodejs.org/download/release/v$NodeVersion/$NodeArchive"
$NodeDirectoryName = "node-v$NodeVersion-win-x64"
$MaximumMjsBytes = 1MB
$MaximumNodeArchiveBytes = 256MB
$MaximumExtractedBytes = 512MB
$MaximumArchiveEntries = 10000
$ScriptDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $PSCommandPath))

function Fail([string] $Message) {
    [Console]::Error.WriteLine("install_cloudbox: $Message")
    exit 1
}

function Assert-WindowsX64 {
    if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
        Fail "Windows 原生首次部署仅支持 64 位 x64。"
    }
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($architecture)) {
        $architecture = $env:PROCESSOR_ARCHITECTURE
    }
    if ($architecture -ne "AMD64") {
        Fail "Windows 原生首次部署仅支持 x64，不支持 $architecture。"
    }
}

function Test-ReparsePoint([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-OrdinaryPath([string] $Path, [bool] $AllowMissing = $true) {
    if (-not (Test-Path -LiteralPath $Path)) {
        if ($AllowMissing) { return }
        Fail "路径不存在：$Path"
    }
    if (Test-ReparsePoint $Path) { Fail "路径是 reparse point，拒绝执行：$Path" }
}

function Ensure-Directory([string] $Path) {
    if (Test-Path -LiteralPath $Path) {
        Assert-OrdinaryPath $Path $false
        if (-not (Get-Item -LiteralPath $Path -Force).PSIsContainer) {
            Fail "路径不是目录：$Path"
        }
        return
    }
    [IO.Directory]::CreateDirectory($Path) | Out-Null
    Assert-OrdinaryPath $Path $false
}

function Get-Sha256([string] $Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Sha256([string] $Path, [string] $Expected) {
    $actual = Get-Sha256 $Path
    if ($actual -ne $Expected.ToLowerInvariant()) {
        Fail "SHA-256 不匹配，拒绝执行：$Path"
    }
}

function New-StagingDirectory([string] $Parent, [string] $Prefix) {
    Ensure-Directory $Parent
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $candidate = Join-Path $Parent (".$Prefix-" + [Guid]::NewGuid().ToString("N"))
        try {
            [IO.Directory]::CreateDirectory($candidate) | Out-Null
            Assert-OrdinaryPath $candidate $false
            return $candidate
        } catch {
            if ($attempt -eq 9) { throw }
        }
    }
    throw "无法创建 staging 目录。"
}

function Test-SafeRedirect([Uri] $Current, [Uri] $Next, [string] $HostName) {
    if ($Next.Scheme -ne "https" -or $Next.Host -ne $HostName) {
        Fail "固定下载发生不受信任的重定向。"
    }
}

function Download-FixedFile([string] $Url, [string] $Destination, [string] $ExpectedSha256, [int64] $MaximumBytes) {
    $initial = [Uri]$Url
    if ($initial.Scheme -ne "https") { Fail "固定下载 URL 必须使用 HTTPS。" }
    $hostName = $initial.Host
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(120)
    $current = $initial
    try {
        for ($redirect = 0; $redirect -le 3; $redirect++) {
            $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $current)
            $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            try {
                if ([int]$response.StatusCode -ge 300 -and [int]$response.StatusCode -lt 400) {
                    if ($redirect -eq 3 -or $null -eq $response.Headers.Location) {
                        Fail "固定下载重定向超过限制。"
                    }
                    $next = [Uri]::new($current, $response.Headers.Location)
                    Test-SafeRedirect $current $next $hostName
                    $current = $next
                    continue
                }
                if (-not $response.IsSuccessStatusCode) {
                    Fail "固定下载失败（HTTP $([int]$response.StatusCode)）。"
                }
                $length = $response.Content.Headers.ContentLength
                if ($null -ne $length -and $length -gt $MaximumBytes) {
                    Fail "固定下载超过大小上限。"
                }
                $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try {
                    $buffer = New-Object byte[] 65536
                    [int64]$total = 0
                    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $total += $read
                        if ($total -gt $MaximumBytes) { Fail "固定下载超过大小上限。" }
                        $output.Write($buffer, 0, $read)
                    }
                } finally {
                    $output.Dispose()
                    $stream.Dispose()
                }
                Assert-Sha256 $Destination $ExpectedSha256
                return
            } finally {
                $response.Dispose()
                $request.Dispose()
            }
        }
        Fail "固定下载重定向失败。"
    } finally {
        $client.Dispose()
        $handler.Dispose()
    }
}

function Get-ProjectRoot {
    $root = [IO.Path]::GetFullPath((Join-Path $ScriptDirectory ".."))
    $markers = @(
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "wrangler.toml",
        "src\index.ts",
        "packages\worker\package.json",
        "packages\dashboard\package.json"
    )
    foreach ($marker in $markers) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $marker))) { return $null }
    }
    return $root
}

function Resolve-MjsPath {
    $projectRoot = Get-ProjectRoot
    $sibling = Join-Path $ScriptDirectory "install_cloudbox.mjs"
    if ($null -ne $projectRoot -and (Test-Path -LiteralPath $sibling)) {
        Assert-OrdinaryPath $sibling $false
        return $sibling
    }
    $localAppData = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($localAppData)) { Fail "未设置 LOCALAPPDATA，无法选择 Windows 用户缓存。" }
    $cacheDirectory = Join-Path $localAppData "cloudbox-r2\cache"
    Ensure-Directory $cacheDirectory
    $final = Join-Path $cacheDirectory ("install_cloudbox-$PayloadRef.mjs")
    if (Test-Path -LiteralPath $final) {
        Assert-OrdinaryPath $final $false
        Assert-Sha256 $final $PayloadSha256
        return $final
    }
    $staging = New-StagingDirectory $cacheDirectory "install_cloudbox-$PayloadRef"
    $temporary = Join-Path $staging "install_cloudbox.mjs"
    try {
        Download-FixedFile "https://raw.githubusercontent.com/ntetv/cloudbox-r2/$PayloadRef/scripts/install_cloudbox.mjs" $temporary $PayloadSha256 $MaximumMjsBytes
        if (Test-Path -LiteralPath $final) { Fail "固定 MJS 缓存目标在发布前出现，拒绝覆盖。" }
        [IO.File]::Move($temporary, $final)
        Assert-OrdinaryPath $final $false
        Assert-Sha256 $final $PayloadSha256
        return $final
    } finally {
        if (Test-Path -LiteralPath $staging) {
            Assert-OrdinaryPath $staging $false
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-Node([string] $NodePath) {
    try {
        $version = (& $NodePath --version 2>$null).Trim()
        if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.\d+\.\d+$' -or [int]$Matches[1] -lt 22) { return $false }
        $arch = (& $NodePath -p "process.arch" 2>$null).Trim()
        return $LASTEXITCODE -eq 0 -and $arch -eq "x64"
    } catch {
        return $false
    }
}

function Get-ExistingNode {
    $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) { return $null }
    if (Test-Node $command.Source) { return $command.Source }
    return $null
}

function Assert-ZipPart([string] $Part) {
    if ([string]::IsNullOrEmpty($Part) -or $Part -in @('.', '..')) { Fail "Node ZIP 包含不安全路径。" }
    if ($Part -match '[<>:"|?*\x00-\x1f]' -or $Part -match '[ .]$') { Fail "Node ZIP 包含 Windows 不允许的文件名。" }
    $stem = ($Part.Split('.')[0]).ToUpperInvariant()
    if ($stem -in @('CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9')) { Fail "Node ZIP 包含 Windows 保留设备名。" }
}

function Extract-NodeZip([string] $ArchivePath, [string] $Destination) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $count = 0
        [int64]$extracted = 0
        foreach ($entry in $archive.Entries) {
            $count++
            if ($count -gt $MaximumArchiveEntries) { Fail "Node ZIP 条目数超过上限。" }
            $name = $entry.FullName.Replace('\', '/')
            $directoryEntry = $name.EndsWith('/')
            $trimmed = $name.TrimEnd('/')
            if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('/') -or $trimmed -match '^[A-Za-z]:') { Fail "Node ZIP 包含绝对路径。" }
            $parts = $trimmed.Split('/')
            foreach ($part in $parts) { Assert-ZipPart $part }
            if ($parts[0] -ne $NodeDirectoryName) { Fail "Node ZIP 顶级目录不匹配。" }
            $target = Join-Path $Destination ($trimmed.Replace('/', '\'))
            $fullTarget = [IO.Path]::GetFullPath($target)
            $fullRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
            if (-not $fullTarget.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) { Fail "Node ZIP 路径越出 staging。" }
            if ($directoryEntry) {
                Ensure-Directory $fullTarget
                continue
            }
            if (Test-Path -LiteralPath $fullTarget) { Fail "Node ZIP 包含重复路径。" }
            $parent = Split-Path -Parent $fullTarget
            Ensure-Directory $parent
            $input = $entry.Open()
            $output = [IO.File]::Open($fullTarget, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $buffer = New-Object byte[] 65536
                while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $extracted += $read
                    if ($extracted -gt $MaximumExtractedBytes) { Fail "Node ZIP 解压大小超过上限。" }
                    $output.Write($buffer, 0, $read)
                }
            } finally {
                $output.Dispose()
                $input.Dispose()
            }
        }
    } finally {
        $archive.Dispose()
    }
}

function Prepare-Node {
    $localAppData = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($localAppData)) { Fail "未设置 LOCALAPPDATA，无法准备 Node.js。" }
    $runtimeRoot = Join-Path $localAppData "cloudbox-r2\runtime"
    Ensure-Directory $runtimeRoot
    $final = Join-Path $runtimeRoot $NodeDirectoryName
    if (Test-Path -LiteralPath $final) {
        Assert-OrdinaryPath $final $false
        $candidate = Join-Path $final "node.exe"
        if (Test-Node $candidate) { return $candidate }
        Fail "Node.js 缓存已存在但校验失败，拒绝覆盖：$final"
    }
    $staging = New-StagingDirectory $runtimeRoot $NodeDirectoryName
    $zip = Join-Path $staging $NodeArchive
    $extract = Join-Path $staging "extract"
    try {
        Ensure-Directory $extract
        Download-FixedFile $NodeUrl $zip $NodeSha256 $MaximumNodeArchiveBytes
        Extract-NodeZip $zip $extract
        $candidate = Join-Path $extract $NodeDirectoryName
        if (-not (Test-Node (Join-Path $candidate "node.exe"))) { Fail "Node.js staging 校验失败。" }
        if (Test-Path -LiteralPath $final) { Fail "Node.js 缓存目标在发布前出现，拒绝覆盖。" }
        [IO.Directory]::Move($candidate, $final)
        Assert-OrdinaryPath $final $false
        if (-not (Test-Node (Join-Path $final "node.exe"))) { Fail "Node.js 发布后校验失败。" }
        return (Join-Path $final "node.exe")
    } finally {
        if (Test-Path -LiteralPath $staging) {
            Assert-OrdinaryPath $staging $false
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

try {
    Assert-WindowsX64
    $mjs = Resolve-MjsPath
    $node = Get-ExistingNode
    if ($null -eq $node) { $node = Prepare-Node }
    $result = 0
    & $node $mjs @RemainingArgs
    $result = $LASTEXITCODE
    exit $result
} catch {
    Fail $_.Exception.Message
}
