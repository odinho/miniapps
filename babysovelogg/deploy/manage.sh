#!/usr/bin/env bash
# babysovelogg deployment & per-family management.
#
# One entry point for the routine ops on a multi-family host: ship new code,
# restart/inspect a baby, and onboard a new family. Generic and env-driven so
# it runs from any operator machine (your laptop, openclaw, CI) — the concrete
# host config lives in local/deploy.env (gitignored), which this auto-sources.
#
# Config (env vars, or local/deploy.env next to the repo):
#   SERVER         ssh target holding the instances     (e.g. user@host)  [required]
#   SSH_AUTH_SOCK  path to your ssh agent socket
#   REMOTE_ROOT    on-host app root                      (default /srv/babysovelogg)
#   APP_USER       on-host service user                  (default babysovelogg)
#   SUDO           prefix for systemctl on the server    (default empty; set "sudo" if SERVER is non-root)
#   ANSIBLE_DIR    provisioning repo's ansible/ dir      (only needed for `add`)
#   PLAYBOOK       playbook filename in ANSIBLE_DIR      (default provision-babysovelogg.yml)
#   VARS_FILE      families/secrets vars file            (default group_vars/babysovelogg/main.yml, relative to ANSIBLE_DIR)
#   BASE_DOMAIN    wildcard base domain                  (no default; needed by `add` to print/verify the URL)
#   VAPID_SUBJECT  mailto: for new families              (default mailto:noreply@babysovelogg.local)
#   PORT_MIN       low end of the reserved port range    (default 3120)
#
# Commands:
#   list                      families present on the host
#   status [family]           systemd activity (one family, or all)
#   deploy [family...]        build + rsync code, then restart families (default: all) and warm up
#   restart <family|all>      restart instance(s) and warm up
#   logs <family> [args...]   journalctl -u babysovelogg@<family> (extra args pass through, e.g. -f -n100)
#   add <name>                onboard a family: pick port+slug, mint VAPID keys, patch ansible vars, run playbook, verify
#   inspect <family>          pull the family db to local/imports/ and run scripts/inspect-db.ts
#   rebuild <family>          replay events / rebuild projections (POST /api/admin/rebuild on the family's port)
#   backup [family|all]       rsync family data dir(s) into local/backups/
#
# Examples:
#   deploy/manage.sh deploy                 # ship current build to every family
#   deploy/manage.sh deploy <family>        # ship + restart just one family
#   deploy/manage.sh add <name>             # onboard a new family
#   deploy/manage.sh inspect <family>       # pull a family's db and summarise it
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$REPO_ROOT/local/deploy.env" ] && source "$REPO_ROOT/local/deploy.env"

: "${REMOTE_ROOT:=/srv/babysovelogg}"
: "${APP_USER:=babysovelogg}"
: "${SUDO:=}"
: "${PLAYBOOK:=provision-babysovelogg.yml}"
: "${VARS_FILE:=group_vars/babysovelogg/main.yml}"
: "${BASE_DOMAIN:=}"
: "${VAPID_SUBJECT:=mailto:noreply@babysovelogg.local}"
: "${PORT_MIN:=3120}"
export SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-}"

die() { echo "error: $*" >&2; exit 1; }
need_server() { [ -n "${SERVER:-}" ] || die "SERVER is not set (put it in local/deploy.env or the environment)"; }
# -n: never read stdin, so ssh inside `while read` loops can't slurp the list.
sh_remote() { need_server; ssh -n "$SERVER" "$@"; }

# All families = subdirectories of $REMOTE_ROOT/families on the host.
families() {
  sh_remote "find '$REMOTE_ROOT/families' -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort"
}

family_exists() { families | grep -qxF "$1"; }
require_family() { family_exists "$1" || die "no such family '$1' on $SERVER (have: $(families | paste -sd, -))"; }

family_port() {
  sh_remote "grep -E '^PORT=' '$REMOTE_ROOT/families/$1/.env' | cut -d= -f2 | tr -d '[:space:]'"
}
family_origin() {
  sh_remote "grep -E '^ORIGIN=' '$REMOTE_ROOT/families/$1/.env' | cut -d= -f2 | tr -d '[:space:]'"
}

warmup() {
  # hooks.server.ts loads on first request, not at boot — warm it so the next
  # restart's SIGTERM cleanup can run before SIGKILL.
  local fam="$1" port; port="$(family_port "$fam")"
  sh_remote "curl -sSo /dev/null -w '  $fam (:$port) -> %{http_code}\n' --max-time 8 http://127.0.0.1:$port/" || echo "  $fam warmup failed"
}

restart_one() {
  local fam="$1"
  echo "==> restart babysovelogg@$fam"
  sh_remote "$SUDO systemctl restart babysovelogg@$fam"
  warmup "$fam"
}

cmd_list() { families; }

cmd_status() {
  if [ $# -ge 1 ]; then
    sh_remote "$SUDO systemctl status --no-pager babysovelogg@$1"
  else
    local fam
    while read -r fam; do
      [ -n "$fam" ] || continue
      printf '%-12s %s\n' "$fam" "$(sh_remote "systemctl is-active babysovelogg@$fam" || true)"
    done < <(families)
  fi
}

cmd_deploy() {
  need_server
  echo "==> build"
  (cd "$REPO_ROOT" && bun run build)

  echo "==> rsync code -> $SERVER:$REMOTE_ROOT/code/"
  # No trailing slashes: preserve the build/ and node_modules/ dir names.
  # --chown: rsync-as-root would otherwise stamp the local UID onto the files.
  rsync -avz --delete --delay-updates --chown="$APP_USER:$APP_USER" \
    -e ssh \
    "$REPO_ROOT/build" "$REPO_ROOT/node_modules" "$REPO_ROOT/package.json" \
    "$SERVER:$REMOTE_ROOT/code/"

  local targets
  if [ $# -ge 1 ]; then targets="$*"; else targets="$(families | paste -sd' ' -)"; fi
  echo "==> restart: $targets"
  local fam
  for fam in $targets; do require_family "$fam"; restart_one "$fam"; done

  echo "==> done"
  for fam in $targets; do echo "  $(family_origin "$fam")"; done
}

cmd_restart() {
  [ $# -ge 1 ] || die "usage: restart <family|all>"
  if [ "$1" = "all" ]; then
    local fam
    while read -r fam; do [ -n "$fam" ] && restart_one "$fam"; done < <(families)
  else
    require_family "$1"; restart_one "$1"
  fi
}

cmd_logs() {
  [ $# -ge 1 ] || die "usage: logs <family> [journalctl-args...]"
  local fam="$1"; shift
  require_family "$fam"
  sh_remote "$SUDO journalctl -u babysovelogg@$fam --no-pager $*"
}

cmd_inspect() {
  [ $# -ge 1 ] || die "usage: inspect <family>"
  require_family "$1"
  local fam="$1" out="$REPO_ROOT/local/imports/$1-$(date +%Y%m%d-%H%M%S).db"
  mkdir -p "$REPO_ROOT/local/imports"
  echo "==> pull $fam db -> $out"
  scp "$SERVER:$REMOTE_ROOT/families/$fam/data.db" "$out"
  echo "==> inspect"
  (cd "$REPO_ROOT" && bun scripts/inspect-db.ts "$out")
}

cmd_rebuild() {
  [ $# -ge 1 ] || die "usage: rebuild <family>"
  require_family "$1"
  local fam="$1" port; port="$(family_port "$fam")"
  echo "==> POST /api/admin/rebuild on $fam (:$port)"
  sh_remote "curl -sS -X POST --max-time 30 http://127.0.0.1:$port/api/admin/rebuild"
  echo
}

cmd_backup() {
  local dest="$REPO_ROOT/local/backups"
  mkdir -p "$dest"
  if [ $# -ge 1 ] && [ "$1" != "all" ]; then
    require_family "$1"
    echo "==> backup $1 -> $dest/$1/"
    mkdir -p "$dest/$1"
    rsync -avz "$SERVER:$REMOTE_ROOT/families/$1/" "$dest/$1/"
  else
    echo "==> backup all families -> $dest/"
    rsync -avz "$SERVER:$REMOTE_ROOT/families/" "$dest/"
  fi
}

cmd_add() {
  [ $# -ge 1 ] || die "usage: add <name>"
  local name="$1"
  [[ "$name" =~ ^[a-z][a-z0-9]*$ ]] || die "family name must be lowercase alnum, starting with a letter"
  [ -n "${ANSIBLE_DIR:-}" ] || die "ANSIBLE_DIR is not set (path to the provisioning repo's ansible/ dir)"
  local vars="$ANSIBLE_DIR/$VARS_FILE"
  [ -f "$vars" ] || die "vars file not found: $vars"
  grep -qE "^[[:space:]]*-?[[:space:]]*name:[[:space:]]*$name([[:space:]]|$)" "$vars" \
    && die "family '$name' already present in $vars"

  # Next free port: one above the current max in the vars file, floored at PORT_MIN.
  local maxport port
  maxport="$(grep -oE 'port:[[:space:]]*[0-9]+' "$vars" | grep -oE '[0-9]+' | sort -n | tail -1 || true)"
  port=$(( ${maxport:-$((PORT_MIN-1))} + 1 ))
  [ "$port" -ge "$PORT_MIN" ] || port="$PORT_MIN"

  # Unguessable-but-typable slug suffix (no vowels/look-alikes).
  local suffix slug
  suffix="$(tr -dc 'a-hjkmnp-z2-9' </dev/urandom | head -c 5)"
  slug="$name-$suffix"

  echo "==> mint VAPID keys for $name"
  local vapid pub priv
  vapid="$(cd "$REPO_ROOT" && bun scripts/generate-vapid-keys.ts)"
  pub="$(printf '%s\n' "$vapid" | grep '^VAPID_PUBLIC_KEY=' | cut -d= -f2-)"
  priv="$(printf '%s\n' "$vapid" | grep '^VAPID_PRIVATE_KEY=' | cut -d= -f2-)"
  [ -n "$pub" ] && [ -n "$priv" ] || die "failed to mint VAPID keys"

  echo "==> patch $vars"
  echo "    name=$name slug=$slug port=$port"
  # Insert the family entry just before the blank line that precedes
  # 'family_secrets:', so it lands at the end of the families: list.
  awk -v n="$name" -v s="$slug" -v p="$port" '
    /^$/ {
      if ((getline nxt) > 0) {
        if (nxt ~ /^family_secrets:/) {
          print "  - name: " n
          print "    slug: " s
          print "    port: " p
          print ""
          print nxt
          next
        }
        print; print nxt; next
      }
      print; next
    }
    { print }
  ' "$vars" > "$vars.tmp" && mv "$vars.tmp" "$vars"
  # Append the secret block (family_secrets is the last block in the file).
  {
    printf '  %s:\n' "$name"
    printf '    vapid_public_key: "%s"\n' "$pub"
    printf '    vapid_private_key: "%s"\n' "$priv"
    printf '    vapid_subject: "%s"\n' "$VAPID_SUBJECT"
  } >> "$vars"

  echo "==> run playbook (provisions dir, .env, systemd, cert, nginx)"
  (cd "$ANSIBLE_DIR" && ansible-playbook "$PLAYBOOK")

  echo "==> verify"
  warmup "$name"
  local url=""
  if [ -n "$BASE_DOMAIN" ]; then
    url="https://$slug.$BASE_DOMAIN"
    curl -sS -o /dev/null -w "  public $url -> %{http_code}\n" --max-time 15 "$url/" || echo "  public check failed (DNS/cert may still be settling)"
  else
    echo "  (set BASE_DOMAIN to print/verify the public URL)"
  fi

  echo "==> done. Family '$name' provisioned${url:+ — live at $url}"
  echo "    Remember to commit the vars change in $ANSIBLE_DIR:"
  echo "      git -C \"$(dirname "$ANSIBLE_DIR")\" add \"$VARS_FILE\" && git commit -m 'babysovelogg: add family \"$name\"'"
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    list)    cmd_list "$@" ;;
    status)  cmd_status "$@" ;;
    deploy)  cmd_deploy "$@" ;;
    restart) cmd_restart "$@" ;;
    logs)    cmd_logs "$@" ;;
    add)     cmd_add "$@" ;;
    inspect) cmd_inspect "$@" ;;
    rebuild) cmd_rebuild "$@" ;;
    backup)  cmd_backup "$@" ;;
    ""|-h|--help|help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \?//'
      ;;
    *) die "unknown command '$cmd' (try: list status deploy restart logs add inspect rebuild backup)" ;;
  esac
}

main "$@"
