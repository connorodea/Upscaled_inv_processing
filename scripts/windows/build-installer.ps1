$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$distRoot = Join-Path $repoRoot "dist\windows"
$appRoot = Join-Path $distRoot "app"
$nodeVersion = "v20.11.1"
$nodeZip = "node-$nodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/$nodeZip"
$nodeDir = Join-Path $appRoot "node"

Write-Host "Building Upscaled Windows installer..." -ForegroundColor Cyan

if (Test-Path $distRoot) {
  Remove-Item -Recurse -Force $distRoot
}
New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
New-Item -ItemType Directory -Force -Path $appRoot | Out-Null

Push-Location $repoRoot
npm ci
npm run build
Pop-Location

Write-Host "Downloading Node.js $nodeVersion..." -ForegroundColor Cyan
$tmpZip = Join-Path $env:TEMP $nodeZip
Invoke-WebRequest -Uri $nodeUrl -OutFile $tmpZip
Expand-Archive -LiteralPath $tmpZip -DestinationPath $appRoot -Force
Rename-Item -Path (Join-Path $appRoot "node-$nodeVersion-win-x64") -NewName "node"

Write-Host "Copying app files..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null

function Copy-Dir {
  param (
    [string]$Source,
    [string]$Destination
  )
  if (-not (Test-Path $Source)) {
    return
  }

  $destPath = Join-Path $Destination (Split-Path $Source -Leaf)
  New-Item -ItemType Directory -Force -Path $destPath | Out-Null

  $logPath = Join-Path $env:TEMP ("robocopy-" + (Split-Path $Source -Leaf) + ".log")
  & robocopy $Source $destPath /E /R:1 /W:1 /NP /NFL /NDL /NJH /NJS /LOG:$logPath
  if ($LASTEXITCODE -ge 8) {
    Write-Host "Robocopy log for ${Source}:" -ForegroundColor Yellow
    Get-Content -Path $logPath -ErrorAction SilentlyContinue | Select-Object -Last 50
    throw "Robocopy failed for $Source (code $LASTEXITCODE)"
  }
}

$copyItems = @(
  "dist",
  "assets",
  "data",
  "MasterManifests",
  "sku_templates",
  "ui",
  "docs"
)

foreach ($item in $copyItems) {
  $src = Join-Path $repoRoot $item
  Copy-Dir -Source $src -Destination $appRoot
}

$packageJson = Join-Path $repoRoot "package.json"
if (Test-Path $packageJson) {
  Copy-Item -Force -Path $packageJson -Destination $appRoot
}

if (Test-Path (Join-Path $appRoot "data\upscaled-sheets-sync.json")) {
  Remove-Item -Force (Join-Path $appRoot "data\upscaled-sheets-sync.json")
}
if (Test-Path (Join-Path $appRoot "data\upscaled-sheets-sync-2.json")) {
  Remove-Item -Force (Join-Path $appRoot "data\upscaled-sheets-sync-2.json")
}

Write-Host "Creating CLI wrapper..." -ForegroundColor Cyan
$binDir = Join-Path $appRoot "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$upscaledCmd = Join-Path $binDir "upscaled.cmd"
@"
@echo off
set "APP_DIR=%~dp0.."
cd /d "%APP_DIR%"
"%APP_DIR%\\node\\node.exe" "%APP_DIR%\\dist\\index.js" %*
"@ | Set-Content -Path $upscaledCmd -Encoding ASCII

Write-Host "Building installer..." -ForegroundColor Cyan
$issPath = Join-Path $repoRoot "installer\\windows\\installer.iss"
& "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe" $issPath

Write-Host "Done. Installer at dist\\windows\\UpscaledSetup.exe" -ForegroundColor Green
