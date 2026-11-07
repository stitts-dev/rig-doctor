#!/usr/bin/env bash
# Creates a one-time invite a player pastes into Rig Doctor to join this relay.
#
#   sudo rig-relay-invite NAME [--hours 24]
#
# The invite carries the API address, the relay's TLS certificate (pinned by
# the app), the relay's WireGuard key and a one-time secret. The player's app
# makes its own WireGuard key, so the relay never sees the private key.
# Only a hash of the secret is stored. Revoke the player later with
# rig-relay-add-peer --remove NAME.
set -euo pipefail
# shellcheck source=relay/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

require_root
load_env
[ -s "$API_DIR/tls.crt" ] || die "relay API not set up; re-run setup.sh"

name='' hours=24
while [ $# -gt 0 ]; do
  case $1 in
    --hours) hours=${2:-}; shift 2 || usage 1 ;;
    -h|--help) usage ;;
    -*) log "unknown option: $1"; usage 1 ;;
    *) name=$1; shift ;;
  esac
done
[[ $name =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "NAME must be 1-32 chars of a-z, 0-9, -"
if ! [[ $hours =~ ^[0-9]+$ ]] || [ "$hours" -lt 1 ] || [ "$hours" -gt 168 ]; then
  die "--hours must be 1-168"
fi
[ ! -f "$CONF_DIR/peers/$name.conf" ] || die "a peer named $name exists; remove it first"

python3 -I - "$API_DIR" "$name" "$hours" "$ENDPOINT" "${API_PORT:-51821}" "$(cat "$CONF_DIR/server.pub")" <<'PY'
import base64, hashlib, json, os, secrets, ssl, sys, time
api_dir, name, hours, endpoint, port, relay_key = sys.argv[1:]
secret = secrets.token_urlsafe(32)
expires = int(time.time()) + int(hours) * 3600
digest = hashlib.sha256(secret.encode()).hexdigest()
p = os.path.join(api_dir, "invites", digest + ".json")
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"name": name, "expires": expires}, f)
with open(os.path.join(api_dir, "tls.crt")) as f:
    der = ssl.PEM_cert_to_DER_cert(f.read())
host = f"[{endpoint}]" if ":" in endpoint else endpoint
inv = {"v": 1, "name": name, "api": f"https://{host}:{port}", "cert": base64.b64encode(der).decode(),
       "relay_key": relay_key, "secret": secret, "expires": expires}
blob = base64.urlsafe_b64encode(json.dumps(inv, separators=(",", ":")).encode()).decode().rstrip("=")
print("rigrelay1." + blob)
PY
# Drop expired invites while we're here.
find "$API_DIR/invites" -name '*.json' -mmin +$((168 * 60)) -delete 2>/dev/null || true
log "invite for $name, valid ${hours}h, works once"
