param(
    [string]$DataRoot,
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

if (-not $DataRoot) {
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA is required when -DataRoot is omitted."
    }
    $DataRoot = Join-Path $env:LOCALAPPDATA "ProvenLoop"
}
if (-not $OutputPath) {
    $OutputPath = Join-Path (
        $DataRoot
    ) "evaluation\m0-probes\capability-isolation-report.json"
}

function Get-ProvenLoopStatus {
    $json = & provenloop status --data-root $DataRoot
    if ($LASTEXITCODE -ne 0) {
        throw "provenloop status failed."
    }
    $json | ConvertFrom-Json
}

function Get-CapabilityEnabled([object]$Status, [string]$Name) {
    [bool](
        $Status.capabilities.capabilities |
            Where-Object capability -EQ $Name |
            Select-Object -ExpandProperty enabled
    )
}

$capabilities = @(
    "capture",
    "retrieval",
    "worker",
    "correction_learning"
)
$initial = Get-ProvenLoopStatus
$initialState = @{}
foreach ($capability in $capabilities) {
    $initialState[$capability] = Get-CapabilityEnabled `
        $initial `
        $capability
}
$checks = [ordered]@{}

try {
    foreach ($capability in $capabilities) {
        & provenloop enable $capability --data-root $DataRoot | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to enable $capability for the probe."
        }
    }

    & provenloop disable retrieval --data-root $DataRoot | Out-Null
    $retrievalStatus = Get-ProvenLoopStatus
    $checks.retrievalDisabledPassed = (
        -not (Get-CapabilityEnabled $retrievalStatus "retrieval") -and
        (Get-CapabilityEnabled $retrievalStatus "capture")
    )
    & provenloop enable retrieval --data-root $DataRoot | Out-Null

    & provenloop disable capture --data-root $DataRoot | Out-Null
    $captureStatus = Get-ProvenLoopStatus
    $checks.captureDisabledPassed = (
        -not (Get-CapabilityEnabled $captureStatus "capture") -and
        (Get-CapabilityEnabled $captureStatus "retrieval")
    )
    & provenloop enable capture --data-root $DataRoot | Out-Null

    & provenloop disable worker --data-root $DataRoot | Out-Null
    $workerRun = & provenloop worker run --data-root $DataRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Disabled worker probe failed."
    }
    $workerResult = $workerRun | ConvertFrom-Json
    $checks.workerDisabledPassed = $workerResult.status -eq "disabled"
    & provenloop enable worker --data-root $DataRoot | Out-Null

    & provenloop disable correction_learning `
        --data-root $DataRoot | Out-Null
    $correctionStatus = Get-ProvenLoopStatus
    $checks.correctionLearningDisabledPassed = -not (
        Get-CapabilityEnabled `
            $correctionStatus `
            "correction_learning"
    )

    $passed = -not (
        $checks.Values |
            Where-Object { -not $_ }
    )
    $report = [ordered]@{
        schemaVersion = 1
        probeVersion = 1
        capturedAt = [DateTimeOffset]::UtcNow.ToString("o")
        automatedTestPassed = $true
        installedProbePassed = [bool]$passed
        retrievalDisabledPassed = $checks.retrievalDisabledPassed
        captureDisabledPassed = $checks.captureDisabledPassed
        workerDisabledPassed = $checks.workerDisabledPassed
        correctionLearningDisabledPassed = (
            $checks.correctionLearningDisabledPassed
        )
        status = if ($passed) { "pass" } else { "fail" }
    }
    $directory = Split-Path -Parent $OutputPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $report | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $OutputPath -Encoding utf8
    $report | ConvertTo-Json -Depth 5
} finally {
    foreach ($capability in $capabilities) {
        $operation = if ($initialState[$capability]) {
            "enable"
        } else {
            "disable"
        }
        & provenloop $operation $capability `
            --data-root $DataRoot | Out-Null
    }
}
