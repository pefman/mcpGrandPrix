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
#     2. `docker compose build` (retags the image) — `agents` is deliberately
#        NOT involved, it is the ephemeral scripted-race runner.
#     3. CANARY (MCPG-41): start the new image side-by-side on alternate
#        LAN-only host ports (3180 / 8180, compose project `mcgp-canary`,
#        docker-compose.canary.yml override) and health-check IT (healthz 2xx
#        + canary server container running + MCP initialize on the canary
#        port) — prod is not touched at all in this step.
#     4. promote: `up -d server client` on the existing project/ports (3080/
#        8080, restart policy unless-stopped) + health check within
#        HEALTH_TIMEOUT_S.
#     5. tear down the canary + remove its log dir.
#     canary fail  -> canary down + re-tag previous image as `latest`,
#                     error, exit 1. Prod untouched; $VPS_STATE_FILE not
#                     updated, so the next run retries.
#     promote fail -> canary down + existing rollback (previous image +
#                     `up -d`), error, exit 1. $VPS_STATE_FILE not updated.
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
#   CANARY_HTTP_PORT canary server host port (default: 3180)
#   CANARY_CLIENT_PORT canary client host port (default: 8180)
#   CANARY_PROJECT   compose project name for the canary (default: mcgp-canary)
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
CANARY_HTTP_PORT="${CANARY_HTTP_PORT:-3180}"
CANARY_CLIENT_PORT="${CANARY_CLIENT_PORT:-8180}"
CANARY_PROJECT="${CANARY_PROJECT:-mcgp-canary}"

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

# curl 2xx against a URL ON the VPS. No output; exit code is the verdict.
vps_health_url() {
  vps "curl -fsS -m 5 -o /dev/null '$1'"
}

# Health check, executed ON the VPS: $HEALTH_URL must answer 2xx AND the
# compose `server` container must be running. No output; exit code is the verdict.
vps_health() {
  vps_health_url "$HEALTH_URL" || return 1
  vps bash -s -- "$VPS_APP_DIR" <<'VPS_HEALTH'
set -u
appdir="$1"
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

# Compose invocation for the canary stack (override file + own project name,
# so it has its own container names, network and volumes and never touches the
# prod `app` project).
canary_compose() {
  local env_flag
  env_flag="$(compose_env_flag)"
  echo "docker compose -p $CANARY_PROJECT -f $VPS_APP_DIR/docker-compose.yml -f $VPS_APP_DIR/docker-compose.canary.yml $env_flag"
}

# Build the persistent-stack image (redeploy step 1). Compose v2 has no
# `up --build` flag, so build and up are separate calls.
compose_build() {
  local env_flag
  env_flag="$(compose_env_flag)"
  vps "cd $VPS_APP_DIR && docker compose $env_flag build $COMPOSE_SERVICES"
}

# Bring the persistent stack up (plain up with the current image).
compose_up() {
  vps "cd $VPS_APP_DIR && docker compose $(compose_env_flag) up -d $COMPOSE_SERVICES"
}

# Start the canary on the alternate ports (MCPG-41). The canary runs the same
# image + same VPS env as prod would — that is exactly what we are proving.
# One-line command on purpose: `vps` passes args to a remote single command
# and a local line continuation would be mangled.
canary_up() {
  vps "CANARY_HTTP_PORT=$CANARY_HTTP_PORT CANARY_CLIENT_PORT=$CANARY_CLIENT_PORT $(canary_compose) up -d $COMPOSE_SERVICES"
}

# Tear down the canary. Idempotent (|| true): runs before every canary_up to
# clear leftovers from a crashed prior run, and after success/failure so the
# VPS never accumulates canary junk.
canary_down() {
  vps "$(canary_compose) down --remove-orphans --timeout 10" || true
}

# Remove the canary's separate log dir (it is not prod's ./log — see
# docker-compose.canary.yml for why the mount must be separate).
canary_cleanup_logs() {
  vps "rm -rf '$VPS_APP_DIR/log-canary'" || true
}

# Can the canary serve MCP at all? POST a JSON-RPC initialize to the canary
# MCP port and require a serverInfo response. Initialize only opens an MCP
# session — it never joins a race, so no game state is touched.
canary_mcp_ok() {
  vps bash -s -- "$CANARY_HTTP_PORT" <<'CANARY_MCP'
set -u
port="$1"
curl -fsS -m 5 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"deploy-canary","version":"0"}}}' \
  "http://localhost:${port}/mcp" 2>/dev/null | grep -q 'serverInfo' && exit 0
exit 1
CANARY_MCP
}

# Canary health = canary healthz 2xx + canary server container running + MCP
# initialize answering (the optional client-port 2xx is included as a 4th
# cheap check — catches a broken static-serve path in the image).
canary_health() {
  vps_health_url "http://localhost:$CANARY_HTTP_PORT/healthz" \
    || return 1
  vps "docker inspect -f '{{.State.Running}}' '$CANARY_PROJECT-server-1' 2>/dev/null | grep -qx true" \
    || return 1
  canary_mcp_ok \
    || return 1
  vps_health_url "http://localhost:$CANARY_CLIENT_PORT/"
}

# Wait up to HEALTH_TIMEOUT_S seconds for the canary to pass all checks.
wait_for_canary() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
  while true; do
    if canary_health; then return 0; fi
    if (( $(date +%s) >= deadline )); then return 1; fi
    sleep 3
  done
}

# Diagnostics on failure: container states + recent logs, for the report.
vps_diagnostics() {
  log "VPS diagnostics (compose ps + last 40 log lines per service):"
  vps "cd $VPS_APP_DIR && docker compose ps && docker compose logs --tail 40 $COMPOSE_SERVICES" || true
}

# Failure path shared by canary and promote failures: tear down the canary
# (never leave it running), restore the "latest = image prod is running" tag
# invariant, then exit non-zero. Prod stack is left exactly as found.
canary_fail_exit() {
  local msg="$1"
  canary_down
  canary_cleanup_logs
  if [[ -n "$old_image" ]]; then
    vps "docker tag $old_image $IMAGE_NAME" || true
  fi
  vps_diagnostics
  err "$msg"
  exit 1
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
  if compose_up && wait_for_health; then
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
  log "  vps: cd $VPS_APP_DIR && docker compose $(compose_env_flag) build $COMPOSE_SERVICES"
  log "  vps: $(canary_compose) down --remove-orphans (clear any prior canary leftovers)"
  log "  vps: CANARY_HTTP_PORT=$CANARY_HTTP_PORT CANARY_CLIENT_PORT=$CANARY_CLIENT_PORT $(canary_compose) up -d $COMPOSE_SERVICES"
  log "  vps: canary health for <= ${HEALTH_TIMEOUT_S}s (healthz on :$CANARY_HTTP_PORT + $CANARY_PROJECT-server-1 running + MCP initialize on :$CANARY_HTTP_PORT + client on :$CANARY_CLIENT_PORT) — prod untouched"
  log "  vps: cd $VPS_APP_DIR && docker compose $(compose_env_flag) up -d $COMPOSE_SERVICES (promote prod to the new image)"
  log "  vps: prod health check for <= ${HEALTH_TIMEOUT_S}s, then $(canary_compose) down + rm -rf $VPS_APP_DIR/log-canary"
  log "  vps: write '$new_sha' to $VPS_STATE_FILE"
  log "  on canary/promote failure: $(canary_compose) down, re-tag previous image as $IMAGE_NAME, prod untouched, exit 1"
  exit 0
fi

log "redeploying: $old_display -> $new_sha"

# Remember the current image so a bad deploy can be rolled back to it (and so
# a failed canary can re-tag `latest` back to the image prod is actually running).
old_image="$(vps "docker image inspect -f '{{.Id}}' $IMAGE_NAME 2>/dev/null || true")"

vps "git -C $VPS_APP_DIR fetch origin && git -C $VPS_APP_DIR reset --hard origin/main"

# Stamp the deployed SHA into client/ for the features page footer (MCPG-35);
# the page omits the line when the file is absent (e.g. local dev).
vps "printf '{\"sha\": \"%s\"}\n' '$new_sha' > $VPS_APP_DIR/client/build-info.json"

# 1) Build the new image (retags $IMAGE_NAME; running prod containers keep
#    their own image ID and are untouched by the build).
compose_build

# 2) Canary: prove the new image on the alternate ports BEFORE touching prod.
#    Idempotent down first clears leftovers from a crashed prior run.
canary_down
log "starting canary (project $CANARY_PROJECT, server :$CANARY_HTTP_PORT, client :$CANARY_CLIENT_PORT)"
if ! canary_up; then
  canary_fail_exit "canary failed to start (port conflict or compose error) — prod untouched"
fi
if ! wait_for_canary; then
  canary_fail_exit "canary unhealthy within ${HEALTH_TIMEOUT_S}s — prod untouched"
fi
log "canary healthy — promoting prod to the new image"

# 3) Promote: recreate the prod stack on its existing ports with the new image.
if ! (compose_up && wait_for_health); then
  canary_down
  vps_diagnostics
  if [[ -n "$old_image" ]]; then
    log "promote failed — rolling back prod to the previous image ($old_display)"
    if vps "docker tag $old_image $IMAGE_NAME" && compose_up && wait_for_health; then
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

# 4) Success: clean up the canary completely, then mark the new SHA deployed.
canary_down
canary_cleanup_logs

# Only a healthy new stack earns the new SHA in the state file.
vps "printf '%s\n' '$new_sha' > '$VPS_STATE_FILE'"
echo "DEPLOYED $old_display -> $new_sha"
