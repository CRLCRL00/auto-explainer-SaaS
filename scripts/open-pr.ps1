# open-pr.ps1 - One-button PR creator (env-aware v0.6.2)
#
# Run:
#   .\scripts\open-pr.bat
# Or with PAT in env (so script doesn't prompt — works in non-TTY contexts):
#   $env:GH_TOKEN='github_pat_***'; .\scripts\open-pr.ps1
#
# Steps:
#   1. Try $env:GH_TOKEN first (script-friendly / non-TTY / CI-friendly)
#   2. If env not set, fall back to Read-Host -AsSecureString (interactive TTY)
#   3. gh auth login --with-token --hostname github.com  (always)
#   4. gh pr create --body-file PR_DESC.md          (always)
#   5. Print the PR URL
#
# v0.6.2 update: env-var support added. Earlier version was blocked in
# non-TTY contexts because Read-Host -AsSecureString needs a real terminal
# (it would hang when invoked from a non-interactive process). Now `$env:GH_TOKEN`
# works in CI, scripts, or any context that has env set.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Pretty header
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " auto-explainer-saas - open PR helper" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Step 1 — get PAT from env OR interactive prompt
$pat = $env:GH_TOKEN
if ([string]::IsNullOrEmpty($pat)) {
    Write-Host "GH_TOKEN env not set - falling back to interactive prompt." -ForegroundColor Yellow
    Write-Host "(You can also: \$env:GH_TOKEN='***'; .\scripts\open-pr.ps1 to skip this prompt)" -ForegroundColor DarkGray
    $secure = Read-Host -Prompt "Paste your GitHub fine-grained PAT and press Enter" -AsSecureString
    if (-not $secure) {
        Write-Host "Empty token - exiting." -ForegroundColor Red
        exit 1
    }
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $pat = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
    }
} else {
    Write-Host "[1/4] Using GH_TOKEN from environment (length=$($pat.Length) chars)" -ForegroundColor Yellow
}

# Step 2 - auth via stdin (gh reads --with-token from stdin)
Write-Host "[2/4] Authenticating gh CLI ..." -ForegroundColor Yellow
$pat | gh auth login --with-token --hostname github.com 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "gh auth login failed." -ForegroundColor Red
    exit 1
}

# Step 3 - verify auth
$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "gh auth status failed." -ForegroundColor Red
    Write-Host $authStatus
    exit 1
}
Write-Host "  authed: $authStatus" -ForegroundColor Green

# Step 4 - create PR. gh reads body from file (--body-file).
Write-Host "[3/4] Creating PR ..." -ForegroundColor Yellow
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$prBodyFile = Join-Path $repoRoot "PR_DESC.md"
if (-not (Test-Path $prBodyFile)) {
    Write-Host "PR_DESC.md not found at $prBodyFile" -ForegroundColor Red
    exit 1
}

# Default title + base/head (can override via env vars $PR_TITLE, $PR_BASE, $PR_HEAD)
$title = if ($env:PR_TITLE) { $env:PR_TITLE } else { 'v0.6.1 deployment-ready (126 commits: LLM fallback + QG + tts phase + Dockerfile + admin UI + 17 TS-error fixes + preventive hardening)' }
$base  = if ($env:PR_BASE)  { $env:PR_BASE  } else { 'main' }
$head  = if ($env:PR_HEAD)  { $env:PR_HEAD  } else { 'feat/v0_0_1' }

$prCreate = gh pr create `
    --repo CRLCRL00/auto-explainer-SaaS `
    --base $base `
    --head $head `
    --title $title `
    --body-file $prBodyFile 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "gh pr create failed." -ForegroundColor Red
    Write-Host $prCreate
    exit 1
}

# Step 5 - print URL
Write-Host "[4/4] Done. PR created." -ForegroundColor Green
$prUrl = gh pr view --json url -q .url 2>&1
Write-Host "  PR URL: $prUrl" -ForegroundColor Cyan
Write-Host ""
Write-Host "Open this URL in your browser to view the PR." -ForegroundColor Yellow

# Secure cleanup (env path keeps $pat as-is; we just null the local ref)
$pat = $null
[System.GC]::Collect()
