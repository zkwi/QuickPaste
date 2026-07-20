[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('warm-first-frame', 'paste-ordinary', 'capture-ledger', 'dpi-mixed')]
  [string]$Scenario,

  [Parameter(Mandatory)]
  [string]$CandidateExecutable,

  [switch]$OptIn
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $OptIn.IsPresent) {
  throw '真实机验收会启动候选程序并可能改写系统剪贴板；请显式传入 -OptIn。'
}
if (-not $IsWindows) {
  throw 'QuickPaste 真实机验收仅支持 Windows。'
}

$candidate = Get-Item -LiteralPath $CandidateExecutable -ErrorAction Stop
if (-not $candidate.PSIsContainer -and $candidate.Extension -ne '.exe') {
  throw 'CandidateExecutable 必须指向 Windows .exe 文件。'
}
if ($candidate.PSIsContainer) {
  throw 'CandidateExecutable 不能是目录。'
}

# 旧候选会忽略未知参数并直接打开真实 app-data；先检查二进制中的固定契约字面量以 fail closed。
$candidateBytes = [IO.File]::ReadAllBytes($candidate.FullName)
$candidateText = [Text.Encoding]::ASCII.GetString($candidateBytes)
foreach ($contractLiteral in @('QUICKPASTE_ACCEPTANCE_PROFILE', 'acceptance-profile-v1.json')) {
  if (-not $candidateText.Contains($contractLiteral, [StringComparison]::Ordinal)) {
    throw "候选程序不含验收 profile 契约：$contractLiteral。拒绝启动以保护真实用户数据库。"
  }
}
$candidateBytes = $null
$candidateText = $null

$runningQuickPaste = Get-Process -Name 'quickpaste' -ErrorAction SilentlyContinue
if ($null -ne $runningQuickPaste) {
  throw '检测到已运行的 QuickPaste。请先正常退出，避免单实例回退到真实用户 profile。'
}

$node = Get-Command node -ErrorAction Stop
$acceptanceModule = Join-Path $PSScriptRoot 'acceptance.mjs'
$preparedJson = & $node.Source $acceptanceModule prepare --scenario $Scenario --opt-in
if ($LASTEXITCODE -ne 0) {
  throw "验收临时目录准备失败，Node 退出码：$LASTEXITCODE"
}
$prepared = $preparedJson | ConvertFrom-Json

$result = Get-Content -LiteralPath $prepared.resultPath -Raw | ConvertFrom-Json
$result.candidate.executableSha256 = (Get-FileHash -LiteralPath $candidate.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$productVersion = $candidate.VersionInfo.ProductVersion
if ($productVersion -match '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') {
  $result.candidate.version = $productVersion
}
$result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $prepared.resultPath -Encoding utf8NoBOM

$previousAppData = [Environment]::GetEnvironmentVariable('APPDATA', 'Process')
$previousLocalAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process')
$previousRunRoot = [Environment]::GetEnvironmentVariable('QUICKPASTE_ACCEPTANCE_RUN_ROOT', 'Process')
$previousAcceptanceProfile = [Environment]::GetEnvironmentVariable('QUICKPASTE_ACCEPTANCE_PROFILE', 'Process')
$previousWebView2UserData = [Environment]::GetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', 'Process')

try {
  [Environment]::SetEnvironmentVariable('APPDATA', $prepared.profileAppData, 'Process')
  [Environment]::SetEnvironmentVariable('LOCALAPPDATA', $prepared.profileLocalAppData, 'Process')
  [Environment]::SetEnvironmentVariable('QUICKPASTE_ACCEPTANCE_RUN_ROOT', $prepared.runRoot, 'Process')
  [Environment]::SetEnvironmentVariable('QUICKPASTE_ACCEPTANCE_PROFILE', $prepared.profileRoot, 'Process')
  [Environment]::SetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', $prepared.webView2UserDataDirectory, 'Process')
  $process = Start-Process -FilePath $candidate.FullName -ArgumentList '--acceptance-metrics' -PassThru
} finally {
  [Environment]::SetEnvironmentVariable('APPDATA', $previousAppData, 'Process')
  [Environment]::SetEnvironmentVariable('LOCALAPPDATA', $previousLocalAppData, 'Process')
  [Environment]::SetEnvironmentVariable('QUICKPASTE_ACCEPTANCE_RUN_ROOT', $previousRunRoot, 'Process')
  [Environment]::SetEnvironmentVariable('QUICKPASTE_ACCEPTANCE_PROFILE', $previousAcceptanceProfile, 'Process')
  [Environment]::SetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', $previousWebView2UserData, 'Process')
}

$markerDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
while (-not (Test-Path -LiteralPath $prepared.acceptanceProfileMarkerPath -PathType Leaf)) {
  if ($process.HasExited) {
    throw "候选程序在创建验收 profile marker 前退出，退出码：$($process.ExitCode)"
  }
  if ([DateTimeOffset]::UtcNow -ge $markerDeadline) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw '候选程序未在 15 秒内确认验收 profile；已终止本次启动。'
  }
  Start-Sleep -Milliseconds 100
}

$markerDocument = $null
$markerValid = $false
try {
  $profileMarkerJson = Get-Content -LiteralPath $prepared.acceptanceProfileMarkerPath -Raw
  $profileMarker = $profileMarkerJson | ConvertFrom-Json
  $markerKeys = @($profileMarker.PSObject.Properties.Name | Sort-Object)
  $markerDocument = [System.Text.Json.JsonDocument]::Parse($profileMarkerJson)
  $formatVersion = $markerDocument.RootElement.GetProperty('formatVersion').GetInt32()
  $createdAt = $markerDocument.RootElement.GetProperty('createdAt').GetString()
  $markerValid = @((Compare-Object $markerKeys @('createdAt', 'formatVersion') -SyncWindow 0)).Count -eq 0 `
    -and $formatVersion -eq 1 `
    -and $createdAt -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
} catch {
  $markerValid = $false
} finally {
  if ($null -ne $markerDocument) { $markerDocument.Dispose() }
}
if (-not $markerValid) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  throw '验收 profile marker 字段无效；已终止本次启动。'
}

[pscustomobject]@{
  RunId = $prepared.runId
  Scenario = $Scenario
  ProcessId = $process.Id
  RunRoot = $prepared.runRoot
  ResultPath = $prepared.resultPath
  EvidenceDirectory = $prepared.evidenceDirectory
  ProfileRoot = $prepared.profileRoot
  AcceptanceProfileMarkerPath = $prepared.acceptanceProfileMarkerPath
  MetricsRelativePath = $prepared.metricsRelativePath
  MetricsPath = $prepared.metricsPath
  ProfileAppData = $prepared.profileAppData
  ProfileLocalAppData = $prepared.profileLocalAppData
  WebView2UserDataDirectory = $prepared.webView2UserDataDirectory
}
