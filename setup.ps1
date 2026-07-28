#!/usr/bin/env pwsh
# Mycel setup (Windows / PowerShell) — the kernel for AI-native service businesses.
# Run:  powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = "Stop"

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Ok($m)   { Write-Host "  [ok] $m"   -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m"    -ForegroundColor Yellow }
function Err($m)  { Write-Host "  [x] $m"    -ForegroundColor Red }
function Ask($prompt, $default) {
  $a = Read-Host "? $prompt [$default]"
  if ([string]::IsNullOrWhiteSpace($a)) { return $default } else { return $a }
}
function AskSecret($prompt) {
  $s = Read-Host "? $prompt (hidden)" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function YesNo($prompt, $default = "n") {
  $a = Ask "$prompt (y/n)" $default
  return ($a -match '^(y|yes)$')
}

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# logo
if (Test-Path "$Here\brand\logo.txt") { Write-Host (Get-Content "$Here\brand\logo.txt" -Raw) -ForegroundColor Green }
else { Write-Host "  M Y C E L" -ForegroundColor Green }
Write-Host "  the kernel for AI-native service businesses`n" -ForegroundColor DarkGray

# prerequisites
Write-Host "Checking prerequisites" -ForegroundColor White
if (Have node) {
  $major = [int](node -p "process.versions.node.split('.')[0]")
  if ($major -ge 20) { Ok "node $(node -v)" } else { Warn "node $(node -v) is < 20 — install 20+ from https://nodejs.org"; exit 1 }
} else { Err "Node.js >= 20 required — install from https://nodejs.org (or: winget install OpenJS.NodeJS)"; exit 1 }
if (Have npm) { Ok "npm $(npm -v)" } else { Err "npm not found"; exit 1 }

# backend
Write-Host "`nWhere should OpenCode run? (sandbox backend)" -ForegroundColor White
Write-Host "  local   — this machine (needs the opencode binary)"
Write-Host "  docker  — a local Docker container"
Write-Host "  daytona — an isolated Daytona microVM (cloud)"
$Backend = Ask "backend" "local"

$DaytonaKey = ""
switch ($Backend) {
  "local" {
    if (Have opencode) { Ok "opencode present" }
    elseif (YesNo "  opencode not found. Install with 'npm i -g opencode-ai'?") { npm install -g opencode-ai; Ok "opencode installed" }
    else { Warn "You'll need the opencode binary before running tasks (or use docker)." }
  }
  "docker" {
    if (Have docker) { Ok "docker present"; if (YesNo "  Build the Mycel sandbox image now?") { docker build -t mycel/sandbox:latest "$Here\docker\sandbox" } }
    else { Warn "Docker not found — install Docker Desktop first." }
  }
  "daytona" { $DaytonaKey = AskSecret "  Daytona API key" }
}

# model + provider key
Write-Host "`nWhich LLM? (provider/model)" -ForegroundColor White
$Model = Ask "model" "anthropic/claude-opus-4-8"
$Provider = $Model.Split("/")[0]
$EnvMap = @{ anthropic = "ANTHROPIC_API_KEY"; openai = "OPENAI_API_KEY"; google = "GOOGLE_GENERATIVE_AI_API_KEY"; openrouter = "OPENROUTER_API_KEY" }
$PkeyVar = if ($EnvMap.ContainsKey($Provider)) { $EnvMap[$Provider] } else { "$($Provider.ToUpper())_API_KEY" }
$Pkey = AskSecret "  $PkeyVar for $Model"

# langfuse
$LfSecret = ""; $LfPublic = ""; $LfHost = ""
if (YesNo "`nEnable Langfuse tracing? (open-source observability)" "n") {
  $LfHost = Ask "  Langfuse host" "https://cloud.langfuse.com"
  $LfPublic = Ask "  LANGFUSE_PUBLIC_KEY" ""
  $LfSecret = AskSecret "  LANGFUSE_SECRET_KEY"
}

# write .env
$EnvFile = "$Here\.env"
if (Test-Path $EnvFile) { Copy-Item $EnvFile "$EnvFile.bak" -Force; Warn "backed up existing .env" }
$lines = @(
  "MYCEL_SANDBOX=$Backend",
  "MYCEL_SANDBOX_IMAGE=mycel/sandbox:latest",
  "OPENCODE_PORT=4444",
  "MYCEL_MODEL=$Model",
  "$PkeyVar=$Pkey",
  "MYCEL_LOG_DIR=.mycel/logs",
  "PORT=4000"
)
if ($DaytonaKey) { $lines += "DAYTONA_API_KEY=$DaytonaKey" }
if ($LfSecret) { $lines += "LANGFUSE_SECRET_KEY=$LfSecret"; $lines += "LANGFUSE_PUBLIC_KEY=$LfPublic"; $lines += "LANGFUSE_HOST=$LfHost" }
$lines -join "`n" | Set-Content -Path $EnvFile -Encoding utf8
Ok "wrote .env"

# install
Write-Host "`nInstalling dependencies" -ForegroundColor White
Push-Location $Here
npm install | Out-Null; Ok "npm install done"
if ($LfSecret) { npm install langfuse | Out-Null; Ok "langfuse installed" }
Pop-Location

Write-Host "`nMycel is set up." -ForegroundColor Green
Write-Host "  Start the harness:  npm run dev" -ForegroundColor Cyan
Write-Host "  Then POST to http://localhost:4000/v1/tasks" -ForegroundColor Cyan
if (YesNo "Start the harness now?" "y") { Push-Location $Here; npm run dev }
