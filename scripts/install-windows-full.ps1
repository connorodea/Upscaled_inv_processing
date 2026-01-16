$ErrorActionPreference = 'Stop'

function Write-Section($text) {
  Write-Host ""
  Write-Host $text -ForegroundColor Cyan
}

$repoDir = (Resolve-Path "$PSScriptRoot\.." ).Path

Write-Section "Upscaled Inventory - Windows Installer"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Section "Installing Node.js LTS..."
  $tmpDir = Join-Path $env:TEMP "upscaled-node"
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $latestInfo = Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt"
  $msiLine = $latestInfo.Content | Select-String -Pattern "node-v.+-x64\.msi"
  if (-not $msiLine) {
    throw "Could not locate Node.js MSI."
  }
  $msiName = ($msiLine -split '\s+')[-1]
  $msiUrl = "https://nodejs.org/dist/latest-v20.x/$msiName"
  $msiPath = Join-Path $tmpDir $msiName
  Invoke-WebRequest -UseBasicParsing -Uri $msiUrl -OutFile $msiPath

  $installArgs = "/i `"$msiPath`" /qn ALLUSERS=2 MSIINSTALLPERUSER=1"
  Start-Process -FilePath "msiexec.exe" -ArgumentList $installArgs -Wait -NoNewWindow

  $nodeUserPath = Join-Path $env:LOCALAPPDATA "Programs\nodejs"
  if (Test-Path $nodeUserPath) {
    $env:Path = "$nodeUserPath;$env:Path"
  }
}

Write-Section "Installing dependencies..."
Push-Location $repoDir
npm install
npm run build
Pop-Location

Write-Section "Configuring Upscaled shortcuts..."
& "$PSScriptRoot\setup-drive-windows.ps1"

$userBin = Join-Path $env:USERPROFILE "bin"
$systemBin = Join-Path $env:ProgramData "Upscaled\bin"
$targetBin = $systemBin
try {
  New-Item -ItemType Directory -Force -Path $systemBin | Out-Null
} catch {
  Write-Host "Could not write to ProgramData. Using user bin." -ForegroundColor Yellow
  $targetBin = $userBin
  New-Item -ItemType Directory -Force -Path $userBin | Out-Null
}

$systemCmd = Join-Path $targetBin "upscaled.cmd"
@"
@echo off
set "repo=$repoDir"
cd /d "%repo%"
node "%repo%\dist\index.js" %*
"@ | Set-Content -Path $systemCmd -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$targetBin*") {
  $newUserPath = if ([string]::IsNullOrEmpty($userPath)) { $targetBin } else { "$userPath;$targetBin" }
  [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
}

if ($targetBin -eq $systemBin) {
  try {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($machinePath -notlike "*$systemBin*") {
      $newMachinePath = if ([string]::IsNullOrEmpty($machinePath)) { $systemBin } else { "$machinePath;$systemBin" }
      [Environment]::SetEnvironmentVariable("Path", $newMachinePath, "Machine")
    }
  } catch {
    Write-Host "Could not update system PATH (admin required). Continuing with user PATH." -ForegroundColor Yellow
  }
}

$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = [Environment]::GetFolderPath("StartMenu")
$programs = Join-Path $startMenu "Programs"

$desktopShortcut = $shell.CreateShortcut((Join-Path $desktop "Upscaled Inventory.lnk"))
$desktopShortcut.TargetPath = "cmd.exe"
$desktopShortcut.Arguments = "/c upscaled"
$desktopShortcut.WorkingDirectory = $repoDir
$iconPath = Join-Path $repoDir "assets\\icon.ico"
if (Test-Path $iconPath) {
  $desktopShortcut.IconLocation = $iconPath
}
$desktopShortcut.Save()

$menuShortcut = $shell.CreateShortcut((Join-Path $programs "Upscaled Inventory.lnk"))
$menuShortcut.TargetPath = "cmd.exe"
$menuShortcut.Arguments = "/c upscaled"
$menuShortcut.WorkingDirectory = $repoDir
if (Test-Path $iconPath) {
  $menuShortcut.IconLocation = $iconPath
}
$menuShortcut.Save()

Write-Host "Done." -ForegroundColor Green
Write-Host "Open a new terminal and run: upscaled"
