#!/usr/bin/env pwsh
# Mycel bootstrap (Windows) — clone + set up in one line:
#   irm https://mycelai.dev/init.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = if ($env:MYCEL_REPO) { $env:MYCEL_REPO } else { "https://github.com/mycelhq/mycel.git" }
$Dir  = if ($env:MYCEL_DIR)  { $env:MYCEL_DIR }  else { "mycel" }

Write-Host "Mycel — the open kernel for AI-native service businesses" -ForegroundColor Green

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "git is required. Install git, then re-run."
  exit 1
}
if (Test-Path $Dir) {
  Write-Host "'$Dir' already exists. cd into it and run .\setup.ps1" -ForegroundColor Cyan
  exit 1
}

Write-Host "  cloning into .\$Dir …" -ForegroundColor Cyan
git clone --depth 1 $Repo $Dir
Set-Location $Dir
powershell -ExecutionPolicy Bypass -File .\setup.ps1
