#!/usr/bin/env bash
# Re-fetches the game server prefix list and reloads the relay firewall.
# Runs daily from rig-relay-refresh.timer. Keeps the old list on failure.
set -euo pipefail
# shellcheck source=relay/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

require_root
load_env
[ -n "${WAN:-}" ] || die "relay not set up; run setup.sh first"

old=$(cat "$CONF_DIR/riot4.txt" 2>/dev/null || true)
update_prefix_file "${PREFIX_SOURCE:-${ASN:-6507}}" "$CONF_DIR/riot4.txt"
if [ "$old" = "$(cat "$CONF_DIR/riot4.txt")" ]; then
  log "prefix list unchanged"
  exit 0
fi
render_firewall "$WAN" "$CONF_DIR/riot4.txt" >"$CONF_DIR/firewall.nft"
if ip link show "$WG_IF" >/dev/null 2>&1; then
  "$LIB_DIR/firewall.sh" up
fi
log "prefix list changed; re-export client configs with rig-relay-add-peer --show NAME"
