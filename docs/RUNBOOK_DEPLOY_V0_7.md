# Runbook — Deploy v0.7 to prod VPS

> **For: user (CRL).** Agent cannot SSH autonomously because classifier blocks
> probing unknown hosts (`agent doesn't know which host is prod yet`). Run
> the commands below in your terminal. Total time: ~5 min.

---

## 0. Pre-flight (already done by agent 2026-07-29)

| Check | Result |
|---|---|
| `git log origin/main --oneline -1` | `1a547f5 chore(audit): B3 preventive audit round — nginx headers + eslint-disable rationale` |
| v0.7 commits since v0.6.1 closing | 6 (B2 retry + SSE + admin UI + B2d tests + B3 audit) |
| `package.json` version | **0.7.0** (was 0.6.0, bumped) |
| `.env.example` schema sync | 6 missing keys added (OPENAI_API_KEY + LLM_OFFLINE_FALLBACK were missing; now present, 5 already commented) |
| `npx vitest run` | **229/229 green** |
| `npx tsc --noEmit` | 0 errors |
| `npm run lint` | 0 warnings |
| `npm run build` | OK |
| `scripts/deploy.sh` syntax | OK (bash -n) |
| `docs/nginx-auto-explainer.conf` structure | OK (5/5 braces balanced, all security headers present) |

The deploy artifacts are ready on `origin/main`. The remaining steps are SSH + runbook commands.

---

## 1. Set VPS env var (one-time per shell)

```bash
# Use whatever IP/hostname you set up. Examples:
# export VPS=user@36.212.72.149
# export VPS=auto-explainer@crlcrl.com
export VPS=user@<your-prod-host>
```

Verify SSH access works:

```bash
ssh -o BatchMode=yes "$VPS" 'echo ok; hostname; uptime' 2>&1
```

If this fails (key not loaded / wrong host), add your SSH key first or set `VPS=root@host` with a working key.

---

## 2. Confirm prod is currently at v0.6.1 (sanity check)

```bash
ssh "$VPS" 'cat /srv/auto-explainer/current/package.json | grep version'
# expected: "version": "0.6.0",
ssh "$VPS" 'systemctl is-active auto-explainer-web auto-explainer-nginx'
# expected: active / active
```

If version is already 0.7.x, you've deployed before — skip this runbook, you're done.

---

## 3. Run deploy.sh

```bash
cd /d/项目/系统   # or wherever your local working copy is
VPS="$VPS" TRIGGER_BASIC_AUTH_USER=admin TRIGGER_BASIC_AUTH_PASS=changeme \
  bash scripts/deploy.sh
```

What deploy.sh does (in order):
1. `npm ci --omit=dev` — production deps
2. Build tarball (excluding `.env*` to prevent secret leak)
3. `scp` tarball to VPS
4. Atomic symlink swap `/srv/auto-explainer/current`
5. `docker compose pull trigger-web clickhouse`
6. `docker compose up -d trigger-web clickhouse`
7. Wait for trigger-web readiness on :3030
8. `sudo systemctl restart auto-explainer-web`
9. **NEW (v0.7 B3)**: sync nginx conf + `sudo nginx -t` + `sudo systemctl reload auto-explainer-nginx`
10. Health check `curl -sf http://127.0.0.1:3000/api/health`
11. Trigger.dev dashboard health check (if basic auth env set)
12. Cleanup old releases (keep 3)

Watch for any `❌` line — those abort the deploy.

---

## 4. Verify nginx security headers are live

```bash
# Headers should now appear on all responses (200, 4xx, 5xx)
ssh "$VPS" 'curl -sI http://127.0.0.1/' | grep -iE 'x-frame|x-content|referrer|permissions'
# expected:
#   x-frame-options: DENY
#   x-content-type-options: nosniff
#   referrer-policy: no-referrer
#   permissions-policy: geolocation=(), microphone=(), camera=()
```

If headers are missing, the conf sync didn't apply. Re-run with debug:

```bash
ssh "$VPS" 'cat /etc/nginx/sites-enabled/auto-explainer.conf | grep add_header'
# expected: 4 add_header lines
```

---

## 5. Smoke test v0.7 admin UI

Open browser: `http://<your-vps>/admin` (basic auth prompt appears)

Verify:
- [ ] Stats panel shows job counts
- [ ] Failed jobs show a green **Retry** button
- [ ] Click Retry → button shows spinner → green checkmark with runId
- [ ] Job row updates **without page reload** (live SSE push) — should change from pending → running → done within ~30s

If retry button doesn't appear, check browser devtools Network tab for `/api/admin/jobs/[id]/events` SSE connection.

---

## 6. Final check

```bash
ssh "$VPS" 'cat /srv/auto-explainer/current/package.json | grep version'
# expected: "version": "0.7.0",
```

✅ **v0.7 deployed.**

---

## Rollback (if needed)

```bash
ssh "$VPS" 'ls /srv/auto-explainer/releases/'
# find the previous version dir, e.g. v20260727120000
ssh "$VPS" 'ln -sfn /srv/auto-explainer/releases/v<previous> /srv/auto-explainer/current.new && \
            mv -Tf /srv/auto-explainer/current.new /srv/auto-explainer/current && \
            sudo systemctl restart auto-explainer-web'
```

---

## Why this isn't fully automated

The Claude Code agent running in this session is constrained by an auto-mode
classifier that blocks SSH to any host it can't prove is the intended target.
Since deploy.sh's `VPS=user@vps-host` default is just a placeholder, the agent
can't run it autonomously without you confirming the host. See
`docs/PR_REVIEW_PROCESS.md` for similar reasoning on why no PR is opened.

If you want this fully automated in the future, you can either:
- Set the actual prod hostname in `scripts/deploy.sh` (replace `vps-host` placeholder)
- Or grant the agent an explicit `Bash` permission rule for your prod SSH target
  in `~/.claude/settings.json`:
  ```json
  { "permissions": { "allow": ["Bash(ssh user@your-vps-host*)"] } }
  ```
