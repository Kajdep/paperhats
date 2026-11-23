<#
.SYNOPSIS
  Start the agent probe and a public HTTPS tunnel, then open the dashboard.

.DESCRIPTION
  Cloud agents (Grok Bot, Dot, Muse, Cue) can only reach a public HTTPS URL.
  This starts the probe on localhost and a Cloudflare quick tunnel
  (no account needed), then opens the dashboard on the tunnel URL so every
  setup prompt already contains the right per-agent MCP URL.

  Local agents (Hermes, OpenClaw) can use http://localhost:<port>/mcp/<token> directly.

  Stop everything with Ctrl+C.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\start-probe.ps1
  powershell -ExecutionPolicy Bypass -File .\start-probe.ps1 -NoTunnel
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$NoTunnel
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22+ is required: winget install OpenJS.NodeJS.LTS"
}

$env:PORT = "$Port"
# The server's console goes to data\server.log, so keep tokens out of it.
$env:PROBE_QUIET_SECRETS = "1"
$serverLog = Join-Path $PSScriptRoot "data\server.log"
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "data") | Out-Null
$server = Start-Process node -ArgumentList "server.mjs" -NoNewWindow -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err"
$configFile = Join-Path $PSScriptRoot "data\config.json"
$wait = (Get-Date).AddSeconds(10)
while (-not (Test-Path -LiteralPath $configFile) -and -not $server.HasExited -and (Get-Date) -lt $wait) { Start-Sleep -Milliseconds 300 }
Start-Sleep -Milliseconds 500
if ($server.HasExited -or -not (Test-Path -LiteralPath $configFile)) { Get-Content "$serverLog.err"; throw "Probe server failed to start." }

$config = Get-Content -Raw -LiteralPath $configFile | ConvertFrom-Json
$admin = $config.adminToken
$tunnel = $null
$publicUrl = "http://localhost:$Port"

try {
  if (-not $NoTunnel) {
    if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
      Write-Host "cloudflared not found. Install it with: winget install Cloudflare.cloudflared" -ForegroundColor Yellow
      Write-Host "Continuing local-only (Hermes/OpenClaw on this PC can still connect)." -ForegroundColor Yellow
    } else {
      $tunnelLog = Join-Path $PSScriptRoot "data\tunnel.log"
      if (Test-Path $tunnelLog) { Remove-Item $tunnelLog }
      $tunnel = Start-Process cloudflared -ArgumentList "tunnel","--no-autoupdate","--url","http://localhost:$Port" -NoNewWindow -PassThru -RedirectStandardError $tunnelLog -RedirectStandardOutput "$tunnelLog.out"
      $deadline = (Get-Date).AddSeconds(45)
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 700
        $m = Select-String -Path $tunnelLog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { $publicUrl = $m.Matches[0].Value; break }
      }
      if ($publicUrl -like "http://localhost*") { Write-Host "Tunnel did not report a URL yet; check $tunnelLog" -ForegroundColor Yellow }
    }
  }

  $dashboard = "$publicUrl/?admin=$admin"
  Write-Host ""
  Write-Host "Agent probe is running." -ForegroundColor Green
  Write-Host "  Public URL : $publicUrl"
  Write-Host "  Dashboard  : $dashboard"
  Write-Host ""
  # These URLs and the dashboard link contain secrets. Do not run this script with its
  # output redirected to a file or captured by a transcript or scheduled task log.
  Write-Host "SENSITIVE: the lines below contain secrets. Do not share or log this window." -ForegroundColor Yellow
  Write-Host "Per-agent MCP URLs (secrets - paste each only into its own agent):"
  foreach ($a in $config.agents) {
    Write-Host ("  @{0,-10} {1}/mcp/{2}" -f $a.handle, $publicUrl, $a.token)
  }
  Write-Host ""
  Write-Host "Local agents on this PC can also use http://localhost:$Port/mcp/<token>."
  Write-Host "Results: $publicUrl/admin/results.md?admin=$admin"
  Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
  Start-Process $dashboard | Out-Null

  while (-not $server.HasExited) { Start-Sleep -Seconds 2 }
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
