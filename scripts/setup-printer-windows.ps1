$ErrorActionPreference = 'Stop'

$repoDefault = (Resolve-Path "$PSScriptRoot\.." ).Path
$repoDir = Read-Host "Repo path [$repoDefault]"
if ([string]::IsNullOrWhiteSpace($repoDir)) { $repoDir = $repoDefault }

$printers = Get-Printer | Select-Object Name, DriverName, PortName, Default
if (-not $printers) {
  Write-Host "No printers found on this machine." -ForegroundColor Red
  exit 1
}

$defaultPrinter = $printers | Where-Object { $_.Default -eq $true } | Select-Object -First 1
if (-not $defaultPrinter) {
  Write-Host "No default printer set. Available printers:" -ForegroundColor Yellow
  $printers | ForEach-Object { Write-Host "  - $($_.Name)" }
  $printerName = Read-Host "Enter printer name"
  if ([string]::IsNullOrWhiteSpace($printerName)) {
    Write-Host "Printer name is required." -ForegroundColor Red
    exit 1
  }
  $defaultPrinter = $printers | Where-Object { $_.Name -eq $printerName } | Select-Object -First 1
  if (-not $defaultPrinter) {
    Write-Host "Printer not found: $printerName" -ForegroundColor Red
    exit 1
  }
}

$payload = [ordered]@{
  name       = $defaultPrinter.Name
  driver     = $defaultPrinter.DriverName
  port       = $defaultPrinter.PortName
  detectedAt = (Get-Date).ToString("s")
}

$dataDir = Join-Path $repoDir "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$configPath = Join-Path $dataDir "printer.json"
$payload | ConvertTo-Json | Set-Content -Path $configPath -Encoding ASCII

[Environment]::SetEnvironmentVariable("UPSCALED_PRINTER_NAME", $defaultPrinter.Name, "User")

Write-Host "Printer configured:" -ForegroundColor Green
Write-Host "- Name: $($defaultPrinter.Name)"
Write-Host "- Saved to: $configPath"
Write-Host "- Env var: UPSCALED_PRINTER_NAME (User scope)"
