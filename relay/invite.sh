#!/usr/bin/env bash
# Creates an invite a player pastes into Rig Doctor to join this relay.
#
#   sudo rig-relay-invite NAME [--hours 24]
#   sudo rig-relay-invite --signup [LABEL] [--uses 50] [--hours 720]
#
# A one-time invite makes peer NAME, which is never billed. A signup code works
# for up to --uses players: each gets a generated peer name and a free trial,
# then a subscription when the relay has Stripe keys (billing.py). LABEL is
# the relay's name in the app. The invite carries the API address, the relay's
# TLS certificate (pinned by the app), the relay's WireGuard key and a secret.
# The player's app makes its own WireGuard key, so the relay never sees the
# private key. Only a hash of the secret is stored. Revoke a player later with
# rig-relay-add-peer --remove NAME.
set -euo pipefail
# shellcheck source=relay/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

require_root
load_env
[ -s "$API_DIR/tls.crt" ] || die "relay API not set up; re-run setup.sh"

name='' hours='' signup=0 uses=50
while [ $# -gt 0 ]; do
  case $1 in
    --hours) hours=${2:-}; shift 2 || usage 1 ;;
    --signup) signup=1; shift ;;
    --uses) uses=${2:-}; shift 2 || usage 1 ;;
    -h|--help) usage ;;
    -*) log "unknown option: $1"; usage 1 ;;
    *) name=$1; shift ;;
  esac
done
if [ "$signup" = 1 ]; then
  name=${name:-relay} hours=${hours:-720} max_hours=8760
  if ! [[ $uses =~ ^[0-9]+$ ]] || [ "$uses" -lt 1 ] || [ "$uses" -gt 10000 ]; then
    die "--uses must be 1-10000"
  fi
else
  hours=${hours:-24} max_hours=168 uses=1
fi
[[ $name =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "NAME must be 1-32 chars of a-z, 0-9, -"
if ! [[ $hours =~ ^[0-9]+$ ]] || [ "$hours" -lt 1 ] || [ "$hours" -gt "$max_hours" ]; then
  die "--hours must be 1-$max_hours"
fi
[ "$signup" = 1 ] || [ ! -f "$CONF_DIR/peers/$name.conf" ] || die "a peer named $name exists; remove it first"

python3 -I - "$API_DIR" "$name" "$hours" "$ENDPOINT" "${API_PORT:-51821}" "$(cat "$CONF_DIR/server.pub")" "$signup" "$uses" <<'PY'
import base64, hashlib, json, os, secrets, ssl, sys, time
api_dir, name, hours, endpoint, port, relay_key, signup, uses = sys.argv[1:]
signup = signup == "1"
now = int(time.time())
# Drop expired invites while we're here.
inv_dir = os.path.join(api_dir, "invites")
for f in os.listdir(inv_dir):
    p = os.path.join(inv_dir, f)
    try:
        with open(p) as fh:
            if int(json.load(fh).get("expires", 0)) < now:
                os.unlink(p)
    except (OSError, ValueError, AttributeError):
        pass
secret = secrets.token_urlsafe(32)
expires = now + int(hours) * 3600
digest = hashlib.sha256(secret.encode()).hexdigest()
stored = {"name": name, "expires": expires}
if signup:
    stored.update(signup=True, uses=int(uses))
fd = os.open(os.path.join(inv_dir, digest + ".json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(stored, f)
with open(os.path.join(api_dir, "tls.crt")) as f:
    der = ssl.PEM_cert_to_DER_cert(f.read())
host = f"[{endpoint}]" if ":" in endpoint else endpoint
inv = {"v": 1, "name": name, "api": f"https://{host}:{port}", "cert": base64.b64encode(der).decode(),
       "relay_key": relay_key, "secret": secret, "expires": expires}
if signup:
    inv["signup"] = True
blob = base64.urlsafe_b64encode(json.dumps(inv, separators=(",", ":")).encode()).decode().rstrip("=")
print("rigrelay1." + blob)
PY
if [ "$signup" = 1 ]; then
  log "signup code \"$name\", valid ${hours}h, for $uses player(s)"
else
  log "invite for $name, valid ${hours}h, works once"
fi
