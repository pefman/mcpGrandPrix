#!/usr/bin/env bash
#
# deploy.sh — check the MCP Grand Prix VPS and redeploy it from main.
#
# Runs on the AGENT HOST (the machine that holds the VPS SSH key); all VPS
# work happens over SSH. Idempotent by design so it can be run unattended
# (the watchdog autopilot calls it every 3 h): a second run in a row is a
# no-op.
#
# Usage:
#   scripts/deploy.sh            check, then deploy/recover as needed
#   scripts/deploy.sh --dry-run  same reads, print the planned actions, change nothing
#
# Decision logic:
#   newest   = newest `main` SHA (git ls-remote, no local clone needed)
#   deployed = contents of $VPS_STATE_FILE (written by this script after each
#              successful deploy; missing = never deployed via this script)
#
#   newest == deployed:
#     healthy   -> print "UP-TO-DATE <sha>", exit 0
#     unhealthy -> `docker compose up -d` (no rebuild), re-check within
#                  HEALTH_TIMEOUT_S -> "RECOVERED <sha>", exit 0 | error, exit 1
#   newest != deployed (or none deployed yet):
#     1. `git fetch` + `reset --hard origin/main` on the VPS
#     2. `docker compose build` + `up -d server client` (Compose v2 has no
#        `up --build` flag) — restart policy comes from the compose file:
#        unless-stopped. `agents` is deliberately NOT started — it is the
#        ephemeral scripted-race runner.
#     3. health check within HEALTH_TIMEOUT_S
#     ok    -> write newest SHA to $VPS_STATE_FILE, print "DEPLOYED <old> -> <new>", exit 0
#     fail  -> restore the previous image + stack (if any), error, exit 1.
#              $VPS_STATE_FILE is NOT updated, so the next run retries.
#
# "healthy" = curl $HEALTH_URL (checked ON the VPS) returns 2xx AND the
# compose `server` container is running. A finished race exiting 0 and the
# server being auto-restarted by its restart policy is a normal, healthy
# state.
#
# Config (all env-overridable; defaults match the live VPS layout):
#   SSH_TARGET       VPS ssh target                       (default: pefman@192.168.1.14)
#   SSH_KEY          agent-host private key for the VPS   (default: /home/pefman/.ssh/vps-mcgp)
#   SSH_PORT         ssh port                             (default: 22)
#   VPS_APP_DIR      repo clone on the VPS; the compose
#                    file lives here                      (default: /opt/mcgp/app)
#   VPS_STATE_FILE   deployed-SHA marker, owned by this script (default: /opt/mcgp/DEPLOYED_SHA)
#   VPS_ENV_FILE     VPS game env (LAPS, WINDOW_SECONDS, ...) fed to
#                    docker-compose.yml ${VAR} substitution via --env-file;
#                    skipped silently if the file is missing (default: /opt/mcgp/.env)
#   HEALTH_URL       health endpoint, checked ON the VPS  (default: http://localhost:3080/healthz)
#   HEALTH_TIMEOUT_S max seconds to wait for a healthy stack (default: 60)
#
# Tools: bash + git + ssh + curl on the agent host; docker + compose on the VPS.
# No secrets in this file or in the repo — only the agent-host key path.
set -euo pipefail

SSH_TARGET="${SSH_TARGET:-pefman@192.168.1.14}"
SSH_KEY="${SSH_KEY:-/home/pefman/.ssh/vps-mcgp}"
SSH_PORT="${SSH_PORT:-22}"
VPS_APP_DIR="${VPS_APP_DIR:-/opt/mcgp/app}"
VPS_STATE_FILE="${VPS_STATE_FILE:-/opt/mcgp/DEPLOYED_SHA}"
VPS_ENV_FILE="${VPS_ENV_FILE:-/opt/mcgp/.env}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3080/healthz}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-60}"

REPO_URL="https://github.com/pefman/mcpGrandPrix.git"
# Persistent VPS stack. `agents` is deliberately NOT here: it is the one-shot
# scripted-race runner and starting it would auto-start a race.
COMPOSE_SERVICES="server client"
IMAGE_NAME="mcp-grand-prix:latest"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$SSH_KEY" ]]; then
  echo "[deploy] ERROR: SSH key not found: $SSH_KEY (override with SSH_KEY)" >&2
  exit 1
fi

log() { echo "[deploy] $*"; }
err() { echo "[deploy] ERROR: $*" >&2; }

# Run a command on the VPS. BatchMode: never prompt (key is pre-provisioned).
vps() {
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=15 \
      "$SSH_TARGET" "$@"
}

# Health check, executed ON the VPS: $HEALTH_URL must answer 2xx AND the
# compose `server` container must be running. No output; exit code is the verdict.
vps_health() {
  vps bash -s -- "$HEALTH_URL" "$VPS_APP_DIR" <<'VPS_HEALTH'
set -u
url="$1"; appdir="$2"
curl -fsS -m 5 "$url" >/dev/null 2>&1 || exit 1
cid="$(docker compose -f "$appdir/docker-compose.yml" ps -q server 2>/dev/null | head -n 1 || true)"
[ -n "$cid" ] || exit 1
[ "$(docker inspect -f '{{.State.Running}}' "$cid")" = "true" ]
VPS_HEALTH
}

# Wait up to HEALTH_TIMEOUT_S seconds for the stack to become healthy (3 s apart).
wait_for_health() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
  while true; do
    if vps_health; then return 0; fi
    if (( $(date +%s) >= deadline )); then return 1; fi
    sleep 3
  done
}

# --env-file flag for docker compose; empty when the VPS env file is missing.
compose_env_flag() {
  if vps "[ -f '$VPS_ENV_FILE' ]"; then echo "--env-file $VPS_ENV_FILE"; fi
}

# Bring the persistent stack up. $1: "build" = rebuild the image first
# (redeploy); anything else = plain up with the existing image (recovery/rollback).
compose_up() {
  local env_flag
  env_flag="$(compose_env_flag)"
  if [[ "$1" == "build" ]]; then
    # Compose v2 has no `up --build` flag: build explicitly, then up.
    vps "cd $VPS_APP_DIR && docker compose $env_flag build $COMPOSE_SERVICES"
  fi
  vps "cd $VPS_APP_DIR && docker compose $env_flag up -d $COMPOSE_SERVICES"
}

# Diagnostics on failure: container states + recent logs, for the report.
vps_diagnostics() {
  log "VPS diagnostics (compose ps + last 40 log lines per service):"
  vps "cd $VPS_APP_DIR && docker compose ps && docker compose logs --tail 40 $COMPOSE_SERVICES" || true
}

# ---- read state ----------------------------------------------------------
if ! vps "true"; then
  err "cannot reach VPS ($SSH_TARGET) — check network / SSH key"
  exit 1
fi

new_sha="$(git ls-remote "$REPO_URL" refs/heads/main | awk '{print $1}')"
if [[ -z "$new_sha" ]]; then
  err "could not resolve newest main SHA via git ls-remote ($REPO_URL)"
  exit 1
fi

old_sha="$(vps "cat '$VPS_STATE_FILE' 2>/dev/null" || true)"
old_sha="$(printf '%s' "$old_sha" | tr -d '[:space:]')"
old_display="${old_sha:-none}"

healthy=0
if vps_health; then healthy=1; fi

log "newest main : $new_sha"
log "deployed sha: $old_display"
if [[ $healthy == 1 ]]; then log "vps stack   : healthy"; else log "vps stack   : unhealthy"; fi

# ---- same SHA: no-op or recover ------------------------------------------
if [[ "$old_sha" == "$new_sha" ]]; then
  if [[ $healthy == 1 ]]; then
    echo "UP-TO-DATE $new_sha"
    exit 0
  fi

  if [[ $DRY_RUN == 1 ]]; then
    log "DRY-RUN: same SHA but stack unhealthy; would recover with:"
    log "  vps: cd $VPS_APP_DIR && docker compose $(compose_env_flag) up -d $COMPOSE_SERVICES"
    log "  then re-check health for <= ${HEALTH_TIMEOUT_S}s"
    exit 0
  fi

  log "stack unhealthy at $new_sha — recovering (compose up -d, no rebuild)"
  if compose_up "" && wait_for_health; then
    echo "RECOVERED $new_sha"
    exit 0
  fi
  vps_diagnostics
  err "recovery failed: no healthy stack within ${HEALTH_TIMEOUT_S}s"
  exit 1
fi

# ---- different SHA: redeploy ----------------------------------------------
if [[ $DRY_RUN == 1 ]]; then
  log "DRY-RUN: VPS behind main (deployed: $old_display, newest: $new_sha); would:"
  log "  vps: git -C $VPS_APP_DIR fetch origin && git -C $VPS_APP_DIR reset --hard origin/main"
  log "  vps: cd $VPS_APP_DIR && docker compose $(compose_env_flag) build $COMPOSE_SERVICES && docker compose $(compose_env_flag) up -d $COMPOSE_SERVICES"
  log "  vps: health check for <= ${HEALTH_TIMEOUT_S}s, then write '$new_sha' to $VPS_STATE_FILE"
  exit 0
fi

log "redeploying: $old_display -> $new_sha"

# Remember the current image so a bad deploy can be rolled back to it.
old_image="$(vps "docker image inspect -f '{{.Id}}' $IMAGE_NAME 2>/dev/null || true")"

vps "git -C $VPS_APP_DIR fetch origin && git -C $VPS_APP_DIR reset --hard origin/main"

if compose_up "build" && wait_for_health; then
  :
else
  vps_diagnostics
  if [[ -n "$old_image" ]]; then
    log "new deploy unhealthy — rolling back to the previous image ($old_display)"
    if vps "docker tag $old_image $IMAGE_NAME" && compose_up "" && wait_for_health; then
      log "rollback ok: stack healthy again on the previous image"
    else
      vps_diagnostics
      err "deploy of $new_sha failed AND rollback did not restore health — VPS needs attention"
      exit 1
    fi
  else
    err "deploy of $new_sha failed (no previous image to roll back to)"
    exit 1
  fi
  err "deploy of $new_sha failed; previous deploy ($old_display) is restored"
  exit 1
fi

# Only a healthy new stack earns the new SHA in the state file.
vps "printf '%s\n' '$new_sha' > '$VPS_STATE_FILE'"
echo "DEPLOYED $old_display -> $new_sha"
