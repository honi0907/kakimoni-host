param(
  [string]$ExePath = "dist\KakiMoni_Host-win32-x64\KakiMoni_Host.exe",
  [string]$CertPath = $env:SIGN_CERT_PFX_PATH,
  [string]$CertPassword = $env:SIGN_CERT_PFX_PASSWORD,
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

function Get-SignToolPath {
  $fromPath = Get-Command signtool -ErrorAction SilentlyContinue
  if ($fromPath) {
    return $fromPath.Source
  }

  $kitsRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
  if (-not (Test-Path $kitsRoot)) {
    throw "signtool was not found in PATH and Windows Kits path is missing: $kitsRoot"
  }

  $candidate = Get-ChildItem -Path $kitsRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  if (-not $candidate) {
    throw "signtool.exe not found under Windows Kits."
  }

  return $candidate.FullName
}

if (-not $CertPath) {
  throw "Missing certificate path. Set SIGN_CERT_PFX_PATH or pass -CertPath."
}
if (-not (Test-Path $CertPath)) {
  throw "Certificate file not found: $CertPath"
}
if (-not (Test-Path $ExePath)) {
  throw "Target exe not found: $ExePath"
}

$signtool = Get-SignToolPath
Write-Host "Using signtool: $signtool"
Write-Host "Signing target: $ExePath"

$signArgs = @(
  "sign",
  "/fd", "SHA256",
  "/td", "SHA256",
  "/tr", $TimestampUrl,
  "/f", $CertPath,
  "/p", $CertPassword,
  $ExePath
)

& $signtool @signArgs
if ($LASTEXITCODE -ne 0) {
  throw "signtool sign failed with exit code $LASTEXITCODE"
}

$verifyArgs = @(
  "verify",
  "/pa",
  "/v",
  $ExePath
)

& $signtool @verifyArgs
if ($LASTEXITCODE -ne 0) {
  throw "signtool verify failed with exit code $LASTEXITCODE"
}

Write-Host "Sign and verify completed successfully."
