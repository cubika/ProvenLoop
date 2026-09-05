param(
    [string]$Version = "0.1.0-alpha.0.7",
    [switch]$NoAutoCollect,
    [switch]$NoLearning,
    [switch]$OnlineDoctor,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Success([string]$Message) {
    Write-Host "OK: $Message" -ForegroundColor Green
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable(
        "Path",
        "Machine"
    )
    $userPath = [Environment]::GetEnvironmentVariable(
        "Path",
        "User"
    )
    $env:Path = "$machinePath;$userPath"
}

function Require-Success(
    [string]$Operation,
    [int[]]$AllowedExitCodes = @(0)
) {
    if ($LASTEXITCODE -notin $AllowedExitCodes) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

function Ensure-UserPath([string]$Directory) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @(
        ($userPath -split ";" | Where-Object {
            -not [string]::IsNullOrWhiteSpace($_)
        })
    )
    $normalizedDirectory = $Directory.TrimEnd("\")
    $retained = @(
        $entries | Where-Object {
            $_.TrimEnd("\") -ine $normalizedDirectory
        }
    )
    $updated = @(
        $normalizedDirectory
        $retained
    ) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $updated, "User")
    $env:Path = "$normalizedDirectory;$env:Path"
}

function Resolve-ProvenLoopCommand([string]$InstallPrefix) {
    $candidate = Join-Path $InstallPrefix "provenloop.cmd"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return $candidate
    }
    throw "The provenloop command was not created by npm."
}

if ($env:OS -ne "Windows_NT") {
    throw "ProvenLoop 0.1 Alpha supports Windows only."
}
if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is required to install ProvenLoop."
}
if (-not $env:TEMP) {
    throw "TEMP is required to install ProvenLoop."
}

$releaseRoot = (
    "https://github.com/cubika/ProvenLoop/releases/download/" +
    "v$Version"
)
$fileName = "provenloop-cli-$Version.tgz"
$packageUrl = "$releaseRoot/$fileName"
$checksumUrl = "$packageUrl.sha256"

if ($DryRun) {
    Write-Host "ProvenLoop installer dry run"
    Write-Host "Version: $Version"
    Write-Host "Package: $packageUrl"
    Write-Host "Checksum: $checksumUrl"
    Write-Host "Automatic collection: $(-not $NoAutoCollect)"
    Write-Host "Retrieval and correction learning: $(-not $NoLearning)"
    Write-Host "Online Doctor: $OnlineDoctor"
    return
}

Write-Step "Checking Node.js"
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($null -eq $winget) {
        throw (
            "Node.js 22 is required. Install Node.js >=22.16 and <23, " +
            "then run this installer again."
        )
    }
    $choice = Read-Host (
        "Node.js is missing. Install Node.js 22 with winget? [Y/n]"
    )
    if (
        -not [string]::IsNullOrWhiteSpace($choice) -and
        $choice -notmatch "^[Yy]"
    ) {
        throw "Node.js installation was declined."
    }
    & $winget.Source install `
        --id OpenJS.NodeJS.22 `
        --exact `
        --source winget `
        --accept-source-agreements `
        --accept-package-agreements
    Require-Success "Node.js installation" @(0, -1978335189)
    Refresh-ProcessPath
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        throw (
            "Node.js was installed but is not available in this shell. " +
            "Open a new terminal and run the installer again."
        )
    }
}

$nodeText = (& $nodeCommand.Source --version | Out-String).Trim()
Require-Success "Node.js version check"
$nodeVersion = [Version]($nodeText.TrimStart("v"))
if (
    $nodeVersion.Major -ne 22 -or
    $nodeVersion -lt [Version]"22.16.0"
) {
    throw (
        "ProvenLoop requires Node.js >=22.16 and <23. " +
        "Detected $nodeText. Install Node.js 22 and rerun the installer."
    )
}
& $nodeCommand.Source -e (
    "const { backup, DatabaseSync } = require('node:sqlite');" +
    "const db = new DatabaseSync(':memory:', { timeout: 1 });" +
    "if (typeof backup !== 'function') process.exit(1);" +
    "db.close();"
) 2>$null
if ($LASTEXITCODE -ne 0) {
    throw (
        "The installed Node.js runtime does not provide the required " +
        "node:sqlite DatabaseSync timeout and backup APIs."
    )
}
Write-Success "Node.js $nodeText"

Write-Step "Checking npm"
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
    throw "npm is required and was not found."
}
$npmText = (& $npmCommand.Source --version | Out-String).Trim()
Require-Success "npm version check"
$npmVersion = [Version]$npmText
if ($npmVersion.Major -lt 11 -or $npmVersion.Major -ge 12) {
    throw (
        "ProvenLoop requires npm >=11 and <12. " +
        "Detected npm $npmText."
    )
}
Write-Success "npm $npmText"

Write-Step "Checking GitHub Copilot CLI"
$copilotCommand = Get-Command copilot.exe -ErrorAction SilentlyContinue
if ($null -eq $copilotCommand) {
    throw "GitHub Copilot CLI >=1.0.71 is required."
}
$copilotText = (& $copilotCommand.Source --version | Out-String).Trim()
Require-Success "Copilot CLI version check"
$copilotVersionMatch = [regex]::Match(
    $copilotText,
    "GitHub Copilot CLI\s+([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9]+))?(?:\.|\s|$)"
)
if (-not $copilotVersionMatch.Success) {
    throw (
        "Unable to parse the GitHub Copilot CLI version. " +
        "Detected: $copilotText"
    )
}
$copilotMajor = [int]$copilotVersionMatch.Groups[1].Value
$copilotMinor = [int]$copilotVersionMatch.Groups[2].Value
$copilotPatch = [int]$copilotVersionMatch.Groups[3].Value
if (
    $copilotMajor -lt 1 -or
    (
        $copilotMajor -eq 1 -and
        (
            $copilotMinor -lt 0 -or
            (
                $copilotMinor -eq 0 -and
                $copilotPatch -lt 71
            )
        )
    )
) {
    throw (
        "ProvenLoop 0.1 Alpha requires GitHub Copilot CLI >=1.0.71. " +
        "Detected: $copilotText"
    )
}
$requiredCopilotCommands = @(
    @{
        Arguments = @("plugin", "marketplace", "list", "--help")
        Operation = "Copilot Plugin Marketplace"
    },
    @{
        Arguments = @("plugin", "install", "--help")
        Operation = "Copilot Plugin installation"
    },
    @{
        Arguments = @("plugins", "enable", "--help")
        Operation = "Copilot Plugin enablement"
    },
    @{
        Arguments = @("plugins", "disable", "--help")
        Operation = "Copilot Plugin disablement"
    }
)
foreach ($requiredCommand in $requiredCopilotCommands) {
    $copilotArguments = [string[]]$requiredCommand.Arguments
    & $copilotCommand.Source @copilotArguments *> $null
    if ($LASTEXITCODE -ne 0) {
        throw (
            "$($requiredCommand.Operation) is unavailable in $copilotText. " +
            "ProvenLoop requires Plugin Marketplace, install, enable, and disable commands."
        )
    }
}
Write-Success $copilotText

$temporaryRoot = Join-Path (
    $env:TEMP
) "provenloop-install-$([Guid]::NewGuid().ToString('N'))"
$runtimeRoot = Join-Path $env:LOCALAPPDATA "ProvenLoopRuntime"
$runtimeSlotsRoot = Join-Path $runtimeRoot "versions"
$installPrefix = Join-Path $runtimeSlotsRoot $Version
$packagePath = Join-Path $temporaryRoot $fileName
$checksumPath = "$packagePath.sha256"
$existingInstallation = $false
$runtimeLocatorPath = Join-Path (
    $env:LOCALAPPDATA
) "ProvenLoopIntegration\runtime.json"
if (Test-Path -LiteralPath $runtimeLocatorPath -PathType Leaf) {
    try {
        $runtimeLocator = Get-Content `
            -LiteralPath $runtimeLocatorPath `
            -Raw `
            -Encoding UTF8 |
            ConvertFrom-Json
        if (
            $runtimeLocator.product -eq "ProvenLoopRuntime" -and
            $runtimeLocator.schemaVersion -eq 1 -and
            -not [string]::IsNullOrWhiteSpace(
                [string]$runtimeLocator.nodeExecutable
            ) -and
            -not [string]::IsNullOrWhiteSpace(
                [string]$runtimeLocator.cliBinPath
            ) -and
            (Test-Path `
                -LiteralPath $runtimeLocator.nodeExecutable `
                -PathType Leaf) -and
            (Test-Path `
                -LiteralPath $runtimeLocator.cliBinPath `
                -PathType Leaf)
        ) {
            $existingStatus = (
                & $runtimeLocator.nodeExecutable `
                    $runtimeLocator.cliBinPath `
                    status 2>$null |
                    Out-String
            ) | ConvertFrom-Json
            if (
                $LASTEXITCODE -eq 0 -and
                $existingStatus.installed -eq $true
            ) {
                $existingInstallation = $true
            }
        }
    } catch {
        $existingInstallation = $false
    }
}

try {
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

    Write-Step "Downloading ProvenLoop $Version"
    Invoke-WebRequest `
        -Uri $packageUrl `
        -OutFile $packagePath `
        -UseBasicParsing
    Invoke-WebRequest `
        -Uri $checksumUrl `
        -OutFile $checksumPath `
        -UseBasicParsing

    Write-Step "Verifying SHA-256"
    $expectedHash = (
        Get-Content -LiteralPath $checksumPath -Raw
    ).Trim().Split()[0].ToLowerInvariant()
    if ($expectedHash -notmatch "^[a-f0-9]{64}$") {
        throw "The published checksum file is invalid."
    }
    $actualHash = (
        Get-FileHash -LiteralPath $packagePath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "ProvenLoop package checksum mismatch."
    }
    Write-Success "Package checksum verified"

    Write-Step "Installing the verified local tarball into its runtime slot"
    & $npmCommand.Source install `
        --global `
        --prefix $installPrefix `
        $packagePath `
        --ignore-scripts `
        --no-audit `
        --no-fund
    Require-Success "ProvenLoop package installation"

    $provenLoopCommand = Resolve-ProvenLoopCommand $installPrefix
    $metadata = (
        & $provenLoopCommand version |
            Out-String
    ) | ConvertFrom-Json
    Require-Success "ProvenLoop version check"
    if ($metadata.version -ne $Version) {
        throw (
            "Installed ProvenLoop version $($metadata.version) " +
            "does not match $Version."
        )
    }
    Write-Success "Installed ProvenLoop $Version"

    if ($existingInstallation) {
        Write-Step "Upgrading the Copilot integration"
        & $provenLoopCommand upgrade
        Require-Success "ProvenLoop integration upgrade"
        if ($NoAutoCollect) {
            Write-Step "Disabling automatic collection"
            & $provenLoopCommand collection disable | Out-Null
            Require-Success "Collection disable"
        }
    } else {
        Write-Step "Registering the Copilot integration"
        $installArguments = @("install")
        if ($NoAutoCollect) {
            $installArguments += "--no-auto-collect"
        }
        & $provenLoopCommand @installArguments
        Require-Success "ProvenLoop integration installation"
    }

    Ensure-UserPath $installPrefix
    $resolvedCommand = Get-Command provenloop.cmd -ErrorAction SilentlyContinue
    if (
        $null -eq $resolvedCommand -or
        [IO.Path]::GetFullPath($resolvedCommand.Source) -ine
            [IO.Path]::GetFullPath($provenLoopCommand)
    ) {
        throw (
            "PATH does not resolve to the newly installed ProvenLoop " +
            "command at $provenLoopCommand."
        )
    }

    if ($NoLearning) {
        Write-Step "Keeping retrieval and correction learning disabled"
        & $provenLoopCommand disable retrieval | Out-Null
        Require-Success "Retrieval disable"
        & $provenLoopCommand disable correction_learning | Out-Null
        Require-Success "Correction learning disable"
    } elseif (-not $existingInstallation) {
        Write-Step "Enabling retrieval and correction learning"
        & $provenLoopCommand enable retrieval | Out-Null
        Require-Success "Retrieval enable"
        & $provenLoopCommand enable correction_learning | Out-Null
        Require-Success "Correction learning enable"
    } else {
        Write-Step "Preserving existing learning capability settings"
    }

    Write-Step "Running passive Doctor"
    & $provenLoopCommand doctor
    Require-Success "Passive Doctor" @(0, 1)

    if ($OnlineDoctor) {
        Write-Step "Running opt-in online Doctor"
        & $provenLoopCommand doctor --online
        Require-Success "Online Doctor" @(0, 1)
    }

    $finalStatus = (
        & $provenLoopCommand status |
            Out-String
    ) | ConvertFrom-Json
    Require-Success "ProvenLoop status check"
    $capabilities = @{}
    foreach ($capability in $finalStatus.capabilities.capabilities) {
        $capabilities[$capability.capability] = [bool]$capability.enabled
    }
    $collectionEnabled = (
        $capabilities.capture -and
        $capabilities.worker
    )
    $learningEnabled = (
        $capabilities.retrieval -and
        $capabilities.correction_learning
    )

    Write-Host ""
    Write-Success "ProvenLoop installation completed"
    Write-Host "Command: $provenLoopCommand"
    Write-Host "Runtime slot: $installPrefix"
    Write-Host "Data: $env:LOCALAPPDATA\ProvenLoop"
    Write-Host (
        "Automatic collection: " +
        $(if ($collectionEnabled) { "enabled" } else { "disabled" })
    )
    Write-Host (
        "Retrieval and correction learning: " +
        $(if ($learningEnabled) { "enabled" } else { "disabled" })
    )
    Write-Host ""
    Write-Host "Start an evidence window with:"
    Write-Host "  provenloop acceptance start"
    Write-Host "Complete it after closing Copilot with:"
    Write-Host "  provenloop acceptance complete"
} finally {
    Remove-Item `
        -LiteralPath $temporaryRoot `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
}
