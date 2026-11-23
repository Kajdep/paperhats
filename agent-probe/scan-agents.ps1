<#
.SYNOPSIS
  Read-only scan for AI agents, local LLM runtimes and MCP configs on this Windows PC.

.DESCRIPTION
  Looks for Hermes Agent, OpenClaw, Ollama, LM Studio, ComfyUI, Claude Desktop/Code,
  ChatGPT desktop, Codex, Gemini CLI, Cursor, OpenCode, Jan, Msty, AnythingLLM,
  GPT4All, tunnels (cloudflared, tailscale, ngrok) and the MCP servers configured
  for Claude Desktop.

  It only reads names, versions, paths and listening ports. It never reads or prints
  API keys, tokens or environment values from config files. Nothing is changed.

  Output: a summary in the console and agent-scan.json next to this script.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scan-agents.ps1
#>

[CmdletBinding()]
param(
  [string]$OutFile = (Join-Path $PSScriptRoot "agent-scan.json"),
  [string[]]$ExtraDrives = @("D:\", "F:\", "H:\")
)

$ErrorActionPreference = "SilentlyContinue"
$found = New-Object System.Collections.Generic.List[object]

function Add-Find {
  param([string]$Category, [string]$Name, [string]$Kind, [string]$Detail)
  $found.Add([pscustomobject]@{ Category = $Category; Name = $Name; Kind = $Kind; Detail = $Detail }) | Out-Null
}

$H = $env:USERPROFILE
$LA = $env:LOCALAPPDATA
$RA = $env:APPDATA

# --------------------------------------------------------------- 1. agent and runtime folders
$paths = [ordered]@{
  "Hermes Agent (config)"        = @("$H\.hermes")
  "OpenClaw (config)"            = @("$H\.openclaw")
  "Claude Code (config)"         = @("$H\.claude")
  "Claude Desktop"               = @("$RA\Claude", "$LA\AnthropicClaude", "$LA\Programs\Claude")
  "Codex CLI (config)"           = @("$H\.codex")
  "Gemini CLI (config)"          = @("$H\.gemini")
  "Cursor"                       = @("$H\.cursor", "$LA\Programs\cursor")
  "OpenCode (config)"            = @("$H\.config\opencode", "$H\.opencode")
  "ChatGPT desktop"              = @("$LA\Programs\ChatGPT", "$LA\OpenAI")
  "Ollama"                       = @("$H\.ollama", "$LA\Programs\Ollama")
  "LM Studio"                    = @("$H\.lmstudio", "$H\.cache\lm-studio", "$LA\Programs\LM Studio", "$LA\Programs\lm-studio")
  "Jan"                          = @("$RA\Jan", "$LA\Programs\jan", "$H\jan")
  "Msty"                         = @("$RA\Msty", "$LA\Programs\Msty")
  "AnythingLLM"                  = @("$RA\anythingllm-desktop", "$LA\Programs\AnythingLLM")
  "GPT4All"                      = @("$LA\nomic.ai", "$H\gpt4all")
  "ComfyUI (Electron desktop)"   = @("$LA\Programs\@comfyorgcomfyui-electron", "$RA\ComfyUI")
  "Grok desktop"                 = @("$LA\Programs\Grok", "$LA\Programs\grok")
  "Perplexity / Comet"           = @("$LA\Programs\Perplexity", "$LA\Perplexity\Comet")
  "Docker Desktop"               = @("$env:ProgramFiles\Docker\Docker")
}
foreach ($name in $paths.Keys) {
  foreach ($p in $paths[$name]) {
    if (Test-Path -LiteralPath $p) { Add-Find "Installed" $name "folder" $p }
  }
}

# --------------------------------------------------------------- 2. commands on PATH
$cmds = "hermes","openclaw","ollama","lms","claude","codex","gemini","cursor","opencode","aider","goose",
        "llama-server","vllm","docker","wsl","node","python","uv","cloudflared","tailscale","ngrok"
foreach ($c in $cmds) {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) {
    $ver = ""
    if ($c -in @("hermes","openclaw","ollama","claude","codex","gemini","opencode","node","cloudflared","tailscale","ngrok","docker")) {
      try {
        $job = Start-Job -ScriptBlock { param($exe) & $exe --version 2>&1 | Select-Object -First 1 } -ArgumentList $cmd.Source
        if (Wait-Job $job -Timeout 8) { $ver = (Receive-Job $job | Out-String).Trim() }
        Remove-Job $job -Force
      } catch {}
    }
    $detail = ("{0}  {1}" -f $cmd.Source, $ver).Trim()
    Add-Find "Command" $c "on PATH" $detail
  }
}

# --------------------------------------------------------------- 3. Store / MSIX apps
$appxPatterns = "*ChatGPT*","*OpenAI*","*Claude*","*Anthropic*","*Grok*","*xAI*","*Meta*AI*","*Manus*","*Perplexity*","*Copilot*"
foreach ($pat in $appxPatterns) {
  Get-AppxPackage -Name $pat | ForEach-Object { Add-Find "Store app" $_.Name "msix" $_.Version }
}

# --------------------------------------------------------------- 4. running processes
$procPatterns = "hermes","openclaw","ollama","lm studio","lms","claude","chatgpt","codex","gemini","cursor","opencode",
                "jan","msty","anythingllm","gpt4all","comfy","grok","cloudflared","tailscale","ngrok","python","node"
$procs = Get-Process | Where-Object { $n = $_.ProcessName.ToLower(); $procPatterns | Where-Object { $n -like "*$_*" } }
$procs | Group-Object ProcessName | ForEach-Object { Add-Find "Running" $_.Name "process" ("x{0}" -f $_.Count) }

# --------------------------------------------------------------- 5. listening ports
$knownPorts = @{
  11434 = "Ollama API"; 1234 = "LM Studio server"; 8188 = "ComfyUI"; 8000 = "ComfyUI desktop / vLLM / generic";
  18789 = "OpenClaw gateway (default)"; 8642 = "Hermes API server (default)"; 3100 = "Paperclip dev";
  1337 = "Jan API"; 3001 = "AnythingLLM"; 4891 = "GPT4All API"; 10000 = "Msty"; 8787 = "Agent probe"
}
$listening = Get-NetTCPConnection -State Listen | Select-Object -ExpandProperty LocalPort -Unique
foreach ($port in $knownPorts.Keys) {
  if ($listening -contains $port) {
    $owner = (Get-NetTCPConnection -State Listen -LocalPort $port | Select-Object -First 1).OwningProcess
    $pname = (Get-Process -Id $owner).ProcessName
    Add-Find "Listening" $knownPorts[$port] "port $port" "process: $pname"
  }
}

# --------------------------------------------------------------- 6. local models
if (Get-Command ollama -ErrorAction SilentlyContinue) {
  $models = (& ollama list 2>$null) | Select-Object -Skip 1 | ForEach-Object { ($_ -split "\s+")[0] } | Where-Object { $_ }
  foreach ($m in $models) { Add-Find "Model" $m "ollama" "" }
}
if (Get-Command lms -ErrorAction SilentlyContinue) {
  $lm = (& lms ls 2>$null) | Where-Object { $_ -match "/" } | ForEach-Object { $_.Trim() }
  foreach ($m in $lm) { Add-Find "Model" $m "lm studio" "" }
}

# --------------------------------------------------------------- 7. MCP servers configured (names only)
$mcpConfigs = @(
  "$RA\Claude\claude_desktop_config.json",
  "$H\.cursor\mcp.json",
  "$H\.claude.json",
  "$H\.gemini\settings.json"
)
foreach ($cfg in $mcpConfigs) {
  if (Test-Path -LiteralPath $cfg) {
    try {
      $json = Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json
      $servers = $json.mcpServers
      if ($servers) {
        foreach ($prop in $servers.PSObject.Properties) {
          $kind = "stdio"
          if ($prop.Value.url) { $kind = "remote" }
          Add-Find "MCP server" $prop.Name $kind (Split-Path $cfg -Leaf)
        }
      }
    } catch { Add-Find "MCP server" "(unreadable config)" "error" $cfg }
  }
}
if (Test-Path -LiteralPath "$H\.hermes\config.yaml") {
  # Names only: lines directly under mcp_servers that look like "  name:".
  $inBlock = $false
  foreach ($line in Get-Content -LiteralPath "$H\.hermes\config.yaml") {
    if ($line -match '^mcp_servers:\s*$') { $inBlock = $true; continue }
    if ($inBlock -and $line -match '^\S') { $inBlock = $false }
    if ($inBlock -and $line -match '^  ([A-Za-z0-9_.-]+):\s*$') { Add-Find "MCP server" $Matches[1] "hermes" "config.yaml" }
  }
}

# --------------------------------------------------------------- 8. WSL distros (Hermes/OpenClaw often live here)
if (Get-Command wsl -ErrorAction SilentlyContinue) {
  $distros = (& wsl -l -q 2>$null) -replace "`0", "" | Where-Object { $_.Trim() }
  foreach ($d in $distros) {
    $d = $d.Trim()
    Add-Find "WSL" $d "distro" ""
    foreach ($tool in "hermes","openclaw","ollama","claude","codex") {
      $hit = (& wsl -d $d -- sh -lc "command -v $tool" 2>$null) -replace "`0", ""
      if ($hit) { Add-Find "WSL command" $tool "in $d" $hit.Trim() }
    }
  }
}

# --------------------------------------------------------------- 9. model / agent folders on other drives (2 levels)
$folderPatterns = "ollama","lmstudio","lm-studio","comfyui","hermes*","openclaw*","models","llm*","gguf","huggingface"
foreach ($drive in $ExtraDrives) {
  if (Test-Path -LiteralPath $drive) {
    Get-ChildItem -LiteralPath $drive -Directory -Depth 1 | Where-Object {
      $n = $_.Name.ToLower(); $folderPatterns | Where-Object { $n -like $_ }
    } | ForEach-Object { Add-Find "Drive folder" $_.Name "folder" $_.FullName }
  }
}

# --------------------------------------------------------------- output
$result = [pscustomobject]@{
  scannedAt = (Get-Date).ToString("o")
  computer  = $env:COMPUTERNAME
  os        = (Get-CimInstance Win32_OperatingSystem).Caption
  findings  = $found
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutFile -Encoding UTF8

$found | Sort-Object Category, Name | Format-Table -AutoSize Category, Name, Kind, Detail | Out-String -Width 220 | Write-Host
Write-Host ("{0} findings. Saved to {1}" -f $found.Count, $OutFile) -ForegroundColor Green
Write-Host "Nothing secret is included: only names, versions, paths and ports." -ForegroundColor DarkGray
