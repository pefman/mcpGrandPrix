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
#   scripts/deploy.sh --scripted-race
#        NO deploy, NO rebuild: prove the image currently deployed on the VPS
#        runs a full scripted race end-to-end (MCPG-70). Starts the side-by-side
#        canary on isolated ports/network (deployed image + prod env, but
#        MIN_AGENTS=4 overriding the prod solo-play value so four scripted
#        agents fill one grid), runs the four scripted agents against it to a
#        clean finish, asserts the clean finish + the persisted team dossiers,
#        then tears the canary down completely (containers, named log volume,
#        network) and leaves no residue. Prod is never touched; its health is
#        checked before and after as a no-regression proof.
#   (--dry-run composes with --scripted-race: prints that plan instead.)
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
#        self-contained docker-compose.canary.yml) and health-check IT
#        (healthz 2xx + canary server container running + MCP initialize on
#        the canary port) — prod is not touched at all in this step.
#     4. promote: `up -d server client` on the existing project/ports (3080/
#        8080, restart policy unless-stopped) + health check within
#        HEALTH_TIMEOUT_S.
#     5. tear down the canary (down -v, so its log volume is removed too).
#     canary fail  -> canary down + restore previous image ($PREV_TAG ->
#                     `latest`), error, exit 1. Prod untouched;
#                     $VPS_STATE_FILE not updated, so the next run retries.
#     promote fail -> canary down + rollback (restore $PREV_TAG as `latest`
#                     + `up -d`), error, exit 1. $VPS_STATE_FILE not updated.
#
# "healthy" = curl $HEALTH_URL (checked ON the VPS) returns 2xx AND the
# compose `server` container is running AND the prod client root
# ($CLIENT_HEALTH_URL, the client service's static-serve GET /) returns 2xx
# (MCPG-53: without the client check a prod client that dies between deploys
# is invisible to this watchdog). A finished race exiting 0 and the server
# being auto-restarted by its restart policy is a normal, healthy state.
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
#   CLIENT_HEALTH_URL prod client root (static-serve GET /), checked ON the
#                     VPS (default: http://localhost:8080/)
#   HEALTH_TIMEOUT_S max seconds to wait for a healthy stack (default: 60)
#   CANARY_HTTP_PORT canary server host port (default: 3180)
#   CANARY_CLIENT_PORT canary client host port (default: 8180)
#   CANARY_PROJECT   compose project name for the canary (default: mcgp-canary)
#   PREV_TAG         stable tag pinning the previous image before a build;
#                    restored as `latest` on canary/promote failure
#                    (default: mcp-grand-prix:prev)
#   SCRIPTED_MIN_AGENTS --scripted-race: MIN_AGENTS override for the canary;
#                    the four scripted agents need 4 grid slots, but the prod
#                    env file sets 1 for solo play (default: 4)
#   SCRIPTED_RACE_TIMEOUT_S
#                    --scripted-race: max seconds to wait for the scripted
#                    race to finish (default: 2400; the canary agents
#                    watchdog in docker-compose.canary.yml is set lower, so a
#                    hung race fails with a clear agents error first)
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
CLIENT_HEALTH_URL="${CLIENT_HEALTH_URL:-http://localhost:8080/}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-60}"
CANARY_HTTP_PORT="${CANARY_HTTP_PORT:-3180}"
CANARY_CLIENT_PORT="${CANARY_CLIENT_PORT:-8180}"
CANARY_PROJECT="${CANARY_PROJECT:-mcgp-canary}"
SCRIPTED_MIN_AGENTS="${SCRIPTED_MIN_AGENTS:-4}"
SCRIPTED_RACE_TIMEOUT_S="${SCRIPTED_RACE_TIMEOUT_S:-2400}"

REPO_URL="https://github.com/pefman/mcpGrandPrix.git"
# Persistent VPS stack. `agents` is deliberately NOT here: it is the one-shot
# scripted-race runner and starting it would auto-start a race.
COMPOSE_SERVICES="server client"
IMAGE_NAME="mcp-grand-prix:latest"
PREV_TAG="${PREV_TAG:-mcp-grand-prix:prev}"

DRY_RUN=0
SCRIPTED_RACE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --scripted-race) SCRIPTED_RACE=1 ;;
    *) echo "usage: $0 [--dry-run | --scripted-race]" >&2; exit 2 ;;
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

# Health check, executed ON the VPS: $HEALTH_URL must answer 2xx, the
# compose `server` container must be running, and the client root
# ($CLIENT_HEALTH_URL) must answer 2xx — the client service's own healthcheck
# (docker-compose.yml, MCPG-53) is Docker observability only; this is what
# makes the 3-hourly watchdog act on a dead prod client. No output; exit
# code is the verdict.
vps_health() {
  vps_health_url "$HEALTH_URL" || return 1
  vps bash -s -- "$VPS_APP_DIR" <<'VPS_HEALTH' || return 1
set -u
appdir="$1"
cid="$(docker compose -f "$appdir/docker-compose.yml" ps -q server 2>/dev/null | head -n 1 || true)"
[ -n "$cid" ] || exit 1
[ "$(docker inspect -f '{{.State.Running}}' "$cid")" = "true" ]
VPS_HEALTH
  vps_health_url "$CLIENT_HEALTH_URL"
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

# Compose invocation for the canary stack: the SELF-CONTAINED canary file
# (single -f, deliberately NOT layered over the base file — Compose v2 merges
# `ports` by {ip, target, published, protocol}, so an override would keep the
# base file's prod ports in the canary too; see docker-compose.canary.yml
# and MCPG-48) + own project name, so it has its own container names, network
# and volumes and never touches the prod `app` project.
canary_compose() {
  local env_flag
  env_flag="$(compose_env_flag)"
  echo "docker compose -p $CANARY_PROJECT -f $VPS_APP_DIR/docker-compose.canary.yml $env_flag"
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
  # -v also removes the canary's named log volume (see docker-compose.canary.yml:
  # the canary log is a named volume, not a bind mount, because daemon-created
  # bind mounts are root-owned and the non-root server can't write them).
  vps "$(canary_compose) down -v --remove-orphans --timeout 10" || true
}

# Start the canary in --scripted-race mode: same as canary_up, but the
# MIN_AGENTS override goes on the compose command line. Shell env beats the
# --env-file value during ${VAR} interpolation (verified on Compose v5.x),
# so the canary server runs the prod env file's pacing with MIN_AGENTS=4
# while prod keeps its solo-play value. Every later compose invocation in
# this mode MUST pass the same override: compose re-evaluates the server's
# config when starting a dependent service, and a config drift would
# recreate the server mid-race.
canary_up_scripted() {
  vps "MIN_AGENTS=$SCRIPTED_MIN_AGENTS CANARY_HTTP_PORT=$CANARY_HTTP_PORT CANARY_CLIENT_PORT=$CANARY_CLIENT_PORT $(canary_compose) up -d $COMPOSE_SERVICES"
}

# Start the canary's one-shot scripted-agent runner (the `agents` service in
# docker-compose.canary.yml, used ONLY by --scripted-race: scripts/runAgents.js
# joins the four scripted agents in fixed order and exits 0 only when the
# server reports the race phase 'finished'). MIN_AGENTS is repeated so the
# server config re-evaluation sees no drift (see canary_up_scripted).
canary_agents_up() {
  vps "MIN_AGENTS=$SCRIPTED_MIN_AGENTS $(canary_compose) up -d agents"
}

# Wait up to SCRIPTED_RACE_TIMEOUT_S for the canary agents container to
# exit. It is one-shot: it exits on race finish (0) or on its own watchdog
# / an agent error (1); the compose-level deadline is backstop only.
wait_for_scripted_race() {
  local deadline=$(( $(date +%s) + SCRIPTED_RACE_TIMEOUT_S ))
  while true; do
    local status
    status="$(vps "docker inspect -f '{{.State.Status}}' '$CANARY_PROJECT-agents-1' 2>/dev/null || true")"
    if [[ "$status" == "exited" || "$status" == "dead" ]]; then return 0; fi
    if (( $(date +%s) >= deadline )); then return 1; fi
    sleep 5
  done
}

# Diagnostics for the CANARY stack (vps_diagnostics targets the prod
# project): canary ps -a + last 40 log lines of its services.
canary_diagnostics() {
  log "VPS diagnostics (canary $CANARY_PROJECT ps -a + last 40 log lines per service):"
  vps "docker compose -p $CANARY_PROJECT -f $VPS_APP_DIR/docker-compose.canary.yml ps -a || true"
  vps "docker logs --tail 40 $CANARY_PROJECT-server-1 2>&1 || true"
  vps "docker logs --tail 40 $CANARY_PROJECT-agents-1 2>&1 || true"
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
  if [[ $have_prev == 1 ]]; then
    vps "docker tag $PREV_TAG $IMAGE_NAME" || true
  fi
  vps_diagnostics
  err "$msg"
  exit 1
}

# ---- scripted-race mode (MCPG-70): canary race, no deploy ------------------
# Proves the DEPLOYED image + prod env run a full 4-scripted-agent race to a
# clean finish on the isolated canary (own project/network/ports/volume),
# asserts the dossier persistence, then leaves zero residue. Prod is not
# touched at any point; its health is sampled before and after as the
# no-regression proof.
run_scripted_race() {
  if ! vps "docker image inspect '$IMAGE_NAME' >/dev/null 2>&1"; then
    err "deployed image $IMAGE_NAME not found on the VPS — run a normal deploy first"
    exit 1
  fi

  local prod_healthy_before=0
  if vps_health; then prod_healthy_before=1; fi

  canary_down
  log "starting scripted-race canary (project $CANARY_PROJECT, server :$CANARY_HTTP_PORT, client :$CANARY_CLIENT_PORT, MIN_AGENTS=$SCRIPTED_MIN_AGENTS, prod env pacing)"
  if ! canary_up_scripted; then
    canary_down
    canary_diagnostics
    err "scripted canary failed to start (port conflict or compose error) — prod untouched"
    exit 1
  fi
  if ! wait_for_canary; then
    canary_down
    canary_diagnostics
    err "scripted canary unhealthy within ${HEALTH_TIMEOUT_S}s — prod untouched"
    exit 1
  fi
  log "canary healthy — starting the $SCRIPTED_MIN_AGENTS scripted agents"

  if ! canary_agents_up; then
    canary_down
    canary_diagnostics
    err "could not start the canary agents container — prod untouched"
    exit 1
  fi
  log "waiting for the scripted race to finish (deadline ${SCRIPTED_RACE_TIMEOUT_S}s)"
  if ! wait_for_scripted_race; then
    canary_down
    canary_diagnostics
    err "scripted race did not finish within ${SCRIPTED_RACE_TIMEOUT_S}s — prod untouched"
    exit 1
  fi

  # Assert 1 — clean finish: the agents runner exits 0 only after the server
  # reported the race phase 'finished' (scripts/runAgents.js). Any agent
  # error or its watchdog exits non-zero.
  local exit_code
  exit_code="$(vps "docker inspect -f '{{.State.ExitCode}}' '$CANARY_PROJECT-agents-1' 2>/dev/null || true")"
  exit_code="${exit_code//[!0-9]/}"
  if [[ "$exit_code" != "0" ]]; then
    canary_down
    canary_diagnostics
    err "scripted race failed: agents container exited $exit_code — prod untouched"
    exit 1
  fi
  log "race finished cleanly (agents exit 0)"

  # Soft check: /state should still report the finished race while the server
  # holds the result (RESULTS_HOLD_SECONDS, default 60). If the hold already
  # elapsed, a fresh session is open and the phase has moved on — normal,
  # not a failure: the deterministic clean-finish proof is the exit code.
  local state_doc state_phase
  state_doc="$(vps "curl -fsS -m 5 'http://localhost:$CANARY_HTTP_PORT/state' 2>/dev/null || true")"
  state_phase="$(printf '%s' "$state_doc" | sed -n 's/.*\"phase\": *\"\([a-z_]*\)\".*/\1/p' | head -n 1)"
  if [[ "$state_phase" == "finished" ]]; then
    log "canary /state confirms phase 'finished'"
  else
    log "canary /state phase '${state_phase:-?}' (result hold may have elapsed — not a failure)"
  fi

  # Assert 2 — dossiers persisted: the canary log volume (named, wiped on
  # teardown) must hold team_dossiers.json with this race's car entries.
  if ! vps bash -s -- "$CANARY_PROJECT" "$SCRIPTED_MIN_AGENTS" <<'CANARY_DOSSIER'
set -u
project="$1"; min_agents="$2"
cid="$(docker ps -q -f name="^${project}-server-1$" | head -n 1)"
[ -n "$cid" ] || exit 1
docker exec "$cid" node -e '
  const fs = require("node:fs");
  const d = JSON.parse(fs.readFileSync("/logs/team_dossiers.json", "utf8"));
  const races = Object.values(d.races ?? {});
  const cars = races.length ? Object.keys(races[races.length - 1].cars).length : 0;
  const min = Number(process.argv[1]);
  if (races.length < 1 || cars < min) {
    console.error(`dossier assert failed: races=${races.length} lastRaceCars=${cars} (need >= ${min})`);
    process.exit(1);
  }
  console.log(`dossier persisted: races=${races.length}, last race cars=${cars}`);
' "$min_agents"
CANARY_DOSSIER
  then
    canary_down
    canary_diagnostics
    err "dossier persistence assert failed (no team_dossiers.json race with $SCRIPTED_MIN_AGENTS cars) — prod untouched"
    exit 1
  fi
  log "dossier assert passed"

  # Full teardown: containers, named log volume and network go away together.
  canary_down

  # Acceptance: no residue — no canary containers (even stopped), no named
  # volume, no network.
  local residue
  residue="$(vps "docker ps -a --filter 'name=$CANARY_PROJECT' --format '{{.Names}}'; docker volume ls --filter 'name=$CANARY_PROJECT' --format '{{.Name}}'; docker network ls --filter 'name=$CANARY_PROJECT' --format '{{.Name}}'")"
  if [[ -n "$residue" ]]; then
    err "canary residue remains after teardown: $residue"
    exit 1
  fi
  log "canary fully torn down (no containers, volumes or networks remain)"

  local prod_healthy_after=0
  if vps_health; then prod_healthy_after=1; fi
  if [[ $prod_healthy_after == 1 ]]; then
    log "prod stack healthy (untouched)"
  elif [[ $prod_healthy_before == 1 ]]; then
    err "prod stack was healthy before the canary and is NOT after — this must not happen; investigate"
    exit 1
  else
    log "WARNING: prod stack unhealthy (pre-existing state; this run never touched prod)"
  fi
  echo "SCRIPTED-RACE OK: clean $SCRIPTED_MIN_AGENTS-agent race on $IMAGE_NAME; canary fully torn down"
}

# ---- read state ----------------------------------------------------------
if ! vps "true"; then
  err "cannot reach VPS ($SSH_TARGET) — check network / SSH key"
  exit 1
fi

# --scripted-race mode is a self-contained canary race: it never deploys,
# never rebuilds and never touches prod, so it dispatches here, before any
# deploy-state reads, and always exits on its own.
if [[ $SCRIPTED_RACE == 1 ]]; then
  if [[ $DRY_RUN == 1 ]]; then
    log "DRY-RUN: --scripted-race would (no deploy, prod untouched):"
    log "  vps: $(canary_compose) down --remove-orphans (clear any prior leftovers)"
    log "  vps: MIN_AGENTS=$SCRIPTED_MIN_AGENTS CANARY_HTTP_PORT=$CANARY_HTTP_PORT CANARY_CLIENT_PORT=$CANARY_CLIENT_PORT $(canary_compose) up -d $COMPOSE_SERVICES (deployed image + prod env pacing)"
    log "  vps: canary health for <= ${HEALTH_TIMEOUT_S}s (healthz :$CANARY_HTTP_PORT + $CANARY_PROJECT-server-1 running + MCP initialize + client :$CANARY_CLIENT_PORT)"
    log "  vps: MIN_AGENTS=$SCRIPTED_MIN_AGENTS $(canary_compose) up -d agents (four scripted agents vs the canary server)"
    log "  vps: wait for the agents container to exit (race to phase 'finished'; deadline ${SCRIPTED_RACE_TIMEOUT_S}s)"
    log "  assert: agents exit code 0 (clean finish) + /logs/team_dossiers.json holds the race's $SCRIPTED_MIN_AGENTS car dossiers"
    log "  vps: $(canary_compose) down -v (removes canary containers, named log volume and network)"
    log "  vps: residue check (no containers/volumes/networks named $CANARY_PROJECT) + prod health re-check"
    exit 0
  fi
  run_scripted_race
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
  log "  vps: prod health check for <= ${HEALTH_TIMEOUT_S}s, then $(canary_compose) down -v (removes canary containers, network and log volume)"
  log "  vps: write '$new_sha' to $VPS_STATE_FILE"
  log "  on canary/promote failure: $(canary_compose) down, restore the previous image ($PREV_TAG -> $IMAGE_NAME), prod untouched, exit 1"
  exit 0
fi

log "redeploying: $old_display -> $new_sha"

# Pin the current image under a stable rollback tag BEFORE the build retags
# $IMAGE_NAME. A tag, not a raw digest: the VPS build runs BuildKit with
# attestations, so $IMAGE_NAME is a manifest list, and the next
# `docker compose build` can remove the old manifest object from the local
# store — re-tagging a remembered `sha256:...` digest then fails with
# "No such image" (MCPG-48). A tag is a local reference that pins the image
# in the store, so it always survives the build.
have_prev=0
if vps "docker tag $IMAGE_NAME $PREV_TAG 2>/dev/null"; then
  have_prev=1
fi

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
  if [[ $have_prev == 1 ]]; then
    log "promote failed — rolling back prod to the previous image ($old_display)"
    if vps "docker tag $PREV_TAG $IMAGE_NAME" && compose_up && wait_for_health; then
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

# Only a healthy new stack earns the new SHA in the state file.
vps "printf '%s\n' '$new_sha' > '$VPS_STATE_FILE'"
# Drop the rollback pin: the new SHA is deployed, so the old image is no
# longer the rollback target (the next deploy pins whatever `latest` is then).
if [[ $have_prev == 1 ]]; then
  vps "docker rmi $PREV_TAG 2>/dev/null" || true
fi
echo "DEPLOYED $old_display -> $new_sha"
