# Install bvl (Browser Valet CLI) from a GitHub release on Windows.
#
#   irm https://github.com/ThilinaTLM/browser-valet/releases/latest/download/install.ps1 | iex
#
# Environment:
#   BVL_VERSION      release tag to install, e.g. v0.2.0 or v0.2.0-rc.1 (default: latest stable)
#   BVL_INSTALL_DIR  where to put bvl.exe (default: %LOCALAPPDATA%\Programs\bvl)
#   BVL_BASE_URL     release download base, for mirrors and tests
#                    (default: https://github.com/ThilinaTLM/browser-valet/releases)
#   BVL_NO_MODIFY_PATH=1  do not add the install folder to the user PATH
#
# Downloads bvl-<target>.zip, checks it against the release's SHA256SUMS and installs bvl.exe.
# Running it again upgrades bvl; the extension follows on its next connection.
# Works in Windows PowerShell 5.1 and PowerShell 7. Everything runs inside one function, so
# `iex` never leaves variables behind and a truncated download cannot run half a script.

function Install-Bvl {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow with the progress bar
    # Windows PowerShell 5.1 may default to TLS 1.0, which GitHub rejects.
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {}

    $base = if ($env:BVL_BASE_URL) { $env:BVL_BASE_URL.TrimEnd('/') } else { 'https://github.com/ThilinaTLM/browser-valet/releases' }
    $version = if ($env:BVL_VERSION) { $env:BVL_VERSION } else { 'latest' }
    if ($version -eq 'latest') {
        $url = "$base/latest/download"
    } elseif ($version.StartsWith('v')) {
        $url = "$base/download/$version"
    } else {
        $url = "$base/download/v$version"
    }
    $dir = if ($env:BVL_INSTALL_DIR) { $env:BVL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\bvl' }

    # PROCESSOR_ARCHITEW6432 is set in a 32-bit shell on 64-bit Windows.
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
        'AMD64' { $target = 'x86_64-pc-windows-msvc' }
        'ARM64' {
            # No native build yet; Windows 11 on ARM runs x64 binaries under emulation.
            Write-Host 'Note: no native ARM64 build; installing the x86_64 build (runs under emulation).'
            $target = 'x86_64-pc-windows-msvc'
        }
        default { throw "bvl install: unsupported CPU architecture: $arch (prebuilt: x86_64)" }
    }
    $asset = "bvl-$target.zip"

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("bvl-install-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        Write-Host "Downloading $asset ($version)"
        $zip = Join-Path $tmp $asset
        $sums = Join-Path $tmp 'SHA256SUMS'
        Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset" -OutFile $zip
        Invoke-WebRequest -UseBasicParsing -Uri "$url/SHA256SUMS" -OutFile $sums

        $want = $null
        foreach ($line in Get-Content $sums) {
            $parts = $line.Trim() -split '\s+', 2
            if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $want = $parts[0].ToLowerInvariant(); break }
        }
        if (-not $want) { throw "bvl install: $asset is not listed in SHA256SUMS" }
        $got = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
        if ($want -ne $got) { throw "bvl install: checksum mismatch for $asset (expected $want, got $got)" }
        Write-Host 'Checksum OK'

        $x = Join-Path $tmp 'x'
        Expand-Archive -Path $zip -DestinationPath $x -Force
        $new = Join-Path $x 'bvl.exe'
        if (-not (Test-Path $new)) { throw "bvl install: bvl.exe not found in $asset" }

        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $exe = Join-Path $dir 'bvl.exe'
        $old = "$exe.old"
        # A running bvl.exe (e.g. the proxy) cannot be overwritten, but it can be renamed.
        # The new bvl restarts an older proxy by itself; the .old copy is removed next time.
        if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
        if (Test-Path $exe) {
            if (Test-Path $old) { throw "bvl install: cannot remove $old; run 'bvl stop' and try again" }
            Rename-Item -Path $exe -NewName 'bvl.exe.old'
        }
        Move-Item -Path $new -Destination $exe
        if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }

        $installed = & $exe version
        if ($LASTEXITCODE -ne 0) { throw "bvl install: installed $exe but it does not run" }
        Write-Host "Installed $installed to $exe"

        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $entries = @($userPath -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
        if ($entries -notcontains $dir.TrimEnd('\')) {
            if ($env:BVL_NO_MODIFY_PATH -eq '1') {
                Write-Host ''
                Write-Host "$dir is not on your PATH; add it to use bvl from any terminal."
            } else {
                $newPath = if ($userPath) { "$($userPath.TrimEnd(';'));$dir" } else { $dir }
                [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
                $env:Path = "$env:Path;$dir"
                Write-Host ''
                Write-Host "Added $dir to your user PATH. Open a new terminal to use bvl elsewhere."
            }
        }
        Write-Host ''
        Write-Host 'Next: run `bvl setup` to install the browser extension.'
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

Install-Bvl
