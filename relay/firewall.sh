#!/usr/bin/env bash
# Called by wg-quick PostUp/PostDown: firewall.sh up|down
set -euo pipefail
# shellcheck source=relay/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
load_env

case ${1:-} in
  up)
    nft -f "$CONF_DIR/firewall.nft"
    iptables_forward up
    ;;
  down)
    nft delete table inet "$NFT_TABLE" 2>/dev/null || true
    iptables_forward down
    ;;
  *) die "usage: firewall.sh up|down" ;;
esac
