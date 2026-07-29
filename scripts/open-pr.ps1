# open-pr.ps1 - One-button PR creator for auto-explainer-saas
#
# Run from this repo root:
#   .\scripts\open-pr.ps1
# Or via the wrapper:
#   .\scripts\open-pr.bat
#
# Steps (each with clear output so user sees progress):
#   1. Read your GitHub fine-grained PAT (silent read -AsSecureString)
#   2. Pipe PAT to `gh auth login --with-token` (token never on disk)
#   3. Verify with `gh auth status`
#   4. Run `gh pr create` with PR_DESC.md as body, base=main, head=feat/v0_0_1
#   5. Print the PR URL
#
# No web UI clicks. No bash typing. Just paste PAT once.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Pretty header
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " auto-explainer-saas — open PR helper" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "This will:"
Write-Host "  1. Read your GitHub fine-grained PAT (input hidden)"
Write-Host "  2. Auth gh CLI"
Write-Host "  3. Open a PR for branch feat/v0_0_1 against main"
Write-Host "  4. Print PR URL"
Write-Host ""

# Step 1 — secure silent read of PAT
$secure = Read-Host -Prompt "Paste your GitHub fine-grained PAT and press Enter" -AsSecureString
if (-not $secure) {
    Write-Host "Empty token — exiting." -ForegroundColor Red
    exit 1
}
# Convert SecureString -> plain string just for the pipe (zeroed afterwards)
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $pat = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
}

# Step 2 — auth via stdin (gh reads --with-token from stdin)
# Use Write-Output piped in to avoid leftover newlines tripping the parser.
Write-Host ""
Write-Host "[1/4] Authenticating gh CLI ..." -ForegroundColor Yellow
$pat | gh auth login --with-token --hostname github.com 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "gh auth login failed." -ForegroundColor Red
    exit 1
}

# Step 3 — verify auth
Write-Host "[2/4] Verifying auth ..." -ForegroundColor Yellow
$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "gh auth status failed." -ForegroundColor Red
    Write-Host $authStatus
    exit 1
}
Write-Host "  authed: $authStatus" -ForegroundColor Green

# Step 4 — create PR. gh reads body from file (--body-file).
Write-Host "[3/4] Creating PR ..." -ForegroundColor Yellow
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$prBodyFile = Join-Path $repoRoot "PR_DESC.md"
if (-not (Test-Path $prBodyFile)) {
    Write-Host "PR_DESC.md not found at $prBodyFile" -ForegroundColor Red
    exit 1
}

$prCreate = gh pr create `
    --repo CRLCRL00/auto-explainer-SaaS `
    --base main `
    --head feat/v0_0_1 `
    --title 'v0.6.1 deployment-ready (126 commits: LLM fallback + QG + tts phase + Dockerfile + admin UI + 17 TS-error fixes + preventive hardening)' `
    --body-file $prBodyFile 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "gh pr create failed." -ForegroundColor Red
    Write-Host $prCreate
    exit 1
}

# Step 5 — print URL
Write-Host "[4/4] Done. PR created." -ForegroundColor Green
$prUrl = gh pr view --json url -q .url 2>&1
Write-Host "  PR URL: $prUrl" -ForegroundColor Cyan
Write-Host ""
Write-Host "Open this URL in your browser to view the PR." -ForegroundColor Yellow

# Secure cleanup
$pat = $null
[System.GC]::Collect()
