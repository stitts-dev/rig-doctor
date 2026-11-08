#!/usr/bin/env bash
# Adds a client to the relay and prints its WireGuard config on stdout.
#
#   sudo rig-relay-add-peer NAME                 # relay generates the client key
#   sudo rig-relay-add-peer NAME --pubkey KEY    # client keeps its own private key
#   sudo rig-relay-add-peer --show NAME          # print the config again
#   sudo rig-relay-add-peer --remove NAME        # also revokes its API token
#   sudo rig-relay-add-peer --suspend NAME       # off the tunnel, token kept
#   sudo rig-relay-add-peer --resume NAME        # back on the tunnel
#
# Re-running with an existing NAME prints its config again. Configs pick up the
# current game prefix list, so re-export after the list changes. The relay API
# suspends a signup player whose trial or subscription ended (billing.py).
set -euo pipefail
# shellcheck source=relay/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

require_root
load_env
[ -s "$CONF_DIR/server.pub" ] || die "relay not set up; run setup.sh first"
# One peer change at a time: the relay API and admins share this script.
exec 9>"$CONF_DIR/.peers.lock"
flock 9

mode=add name='' pubkey=''
while [ $# -gt 0 ]; do
  case $1 in
    --show) mode=show; name=${2:-}; shift 2 || usage 1 ;;
    --remove) mode=remove; name=${2:-}; shift 2 || usage 1 ;;
    --suspend) mode=suspend; name=${2:-}; shift 2 || usage 1 ;;
    --resume) mode=resume; name=${2:-}; shift 2 || usage 1 ;;
    --pubkey) pubkey=${2:-}; shift 2 || usage 1 ;;
    -h|--help) usage ;;
    -*) log "unknown option: $1"; usage 1 ;;
    *) name=$1; shift ;;
  esac
done
[[ $name =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "NAME must be 1-32 chars of a-z, 0-9, -"
peer_file="$CONF_DIR/peers/$name.conf"
meta="$CONF_DIR/clients/$name"

show() {
  [ -f "$peer_file" ] || die "no peer named $name"
  local key='<client private key>'
  [ -f "$meta.key" ] && key=$(cat "$meta.key")
  render_client_conf "$name" "$(cat "$meta.ip")" "$key"
}

case $mode in
  show) show; exit 0 ;;
  remove)
    [ -f "$peer_file" ] || die "no peer named $name"
    rm -f "$peer_file" "$meta.ip" "$meta.key" "$meta.token" "$meta.suspended"
    write_wg_conf >/dev/null
    sync_peers
    log "removed $name"
    exit 0
    ;;
  suspend|resume)
    # The peer keeps its address and token; wg0.conf leaves out suspended peers.
    [ -f "$peer_file" ] || die "no peer named $name"
    if [ "$mode" = suspend ]; then touch "$meta.suspended"; else rm -f "$meta.suspended"; fi
    write_wg_conf >/dev/null
    sync_peers
    log "${mode}d $name"
    exit 0
    ;;
esac

if [ -f "$peer_file" ]; then
  log "$name already exists; printing its config"
  show
  exit 0
fi

ip=$(next_client_ip)
[ -n "$ip" ] || die "tunnel network $SUBNET is full"

if [ -z "$pubkey" ]; then
  (umask 077 && wg genkey >"$meta.key")
  pubkey=$(wg pubkey <"$meta.key")
fi
[[ $pubkey =~ ^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$ ]] || die "--pubkey is not a WireGuard public key"

echo "$ip" >"$meta.ip"
cat >"$peer_file" <<PEER
[Peer]
# $name
PublicKey = $pubkey
AllowedIPs = $ip/32
PEER
write_wg_conf >/dev/null
sync_peers
log "added $name as $ip"
show
