#!/usr/bin/env bash
# End-to-end test of relay/setup.sh on a throwaway Ubuntu 24.04 host (CI runner).
# Builds a fake client and a fake internet in network namespaces, then checks
# that game traffic exits via the relay with NAT and everything else is dropped.
# Uses documentation ranges only (RFC 5737). Needs root and the wireguard module.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
GAME=198.51.100.10     # stands in for a Riot game server
OTHER=203.0.113.10     # any non-game destination
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
cx() { ip netns exec rr-client "$@"; }

cleanup() {
  set +e
  pkill -f 'http.server' 2>/dev/null
  ip netns del rr-client 2>/dev/null
  ip netns del rr-inet 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# Fake internet: relay WAN 192.0.2.1 <-> 192.0.2.2 hosting GAME and OTHER.
ip netns add rr-inet
ip link add rr-wan type veth peer name inet0 netns rr-inet
ip addr add 192.0.2.1/24 dev rr-wan && ip link set rr-wan up
ip -n rr-inet addr add 192.0.2.2/24 dev inet0
ip -n rr-inet link set inet0 up && ip -n rr-inet link set lo up
ip -n rr-inet addr add "$GAME/32" dev lo
ip -n rr-inet addr add "$OTHER/32" dev lo
ip route add 198.51.100.0/24 via 192.0.2.2
ip route add 203.0.113.0/24 via 192.0.2.2

# Client network: player 172.30.0.2 reaches the relay at 172.30.0.1.
ip netns add rr-client
ip link add rr-cli type veth peer name cli0 netns rr-client
ip addr add 172.30.0.1/24 dev rr-cli && ip link set rr-cli up
ip -n rr-client addr add 172.30.0.2/24 dev cli0
ip -n rr-client link set cli0 up && ip -n rr-client link set lo up

echo 198.51.100.0/24 >"$WORK/prefixes.txt"
export RIG_RELAY_MIN_PREFIXES=1
"$REPO/relay/setup.sh" --wan rr-wan --endpoint 172.30.0.1 --prefix-file "$WORK/prefixes.txt"
pass "setup.sh first run"

"$REPO/relay/setup.sh" 2>"$WORK/rerun.log"
grep -q 'unchanged' "$WORK/rerun.log" || fail "re-run regenerated wg0.conf: $(cat "$WORK/rerun.log")"
[ "$(nft list tables | grep -c rig_relay)" -eq 1 ] || fail "duplicate nft tables"
pass "setup.sh re-run is a no-op"

rig-relay-add-peer toaster >"$WORK/rrc.conf"
grep -q '^Endpoint = 172.30.0.1:51820$' "$WORK/rrc.conf" || fail "client endpoint: $(cat "$WORK/rrc.conf")"
grep -q '^AllowedIPs = 10.66.66.1/32, 198.51.100.0/24$' "$WORK/rrc.conf" || fail "client AllowedIPs"
grep -q '^Address = 10.66.66.2/32$' "$WORK/rrc.conf" || fail "client address"
cmp -s "$WORK/rrc.conf" <(rig-relay-add-peer toaster 2>/dev/null) || fail "re-adding a peer changed its config"
pass "add-peer prints a split-tunnel client config"

chmod 600 "$WORK/rrc.conf"
cx wg-quick up "$WORK/rrc.conf"

cx ping -c 2 -W 2 10.66.66.1 >/dev/null || fail "client cannot ping relay tunnel address"
pass "client pings the relay over the tunnel"

cx ping -c 2 -W 2 "$GAME" >/dev/null || fail "game traffic does not pass"
pass "game traffic passes"

ip netns exec rr-inet python3 -m http.server --bind "$GAME" 8080 >"$WORK/game.log" 2>&1 &
sleep 1
cx curl -fsS --max-time 5 "http://$GAME:8080/" >/dev/null || fail "game TCP does not pass"
grep -q '^192\.0\.2\.1 ' "$WORK/game.log" || fail "game server did not see the relay address: $(cat "$WORK/game.log")"
pass "game traffic exits NATed to the relay address"

# Force a non-game destination into the tunnel; the relay must drop it.
cx wg set rrc peer "$(cat /etc/rig-relay/server.pub)" allowed-ips 10.66.66.1/32,198.51.100.0/24,203.0.113.0/24
cx ip route add 203.0.113.0/24 dev rrc
! cx ping -c 2 -W 2 "$OTHER" >/dev/null || fail "non-game traffic left the relay"
nft list chain inet rig_relay forward | grep 'non-game egress' | grep -qv 'packets 0 ' || fail "drop counter did not move"
pass "non-game traffic is dropped at the relay"

python3 -m http.server --bind 10.66.66.1 8081 >/dev/null 2>&1 &
sleep 1
! cx curl -fsS --max-time 3 "http://10.66.66.1:8081/" >/dev/null || fail "client reached a relay service"
pass "relay services are closed to clients"

"$REPO/relay/setup.sh" 2>/dev/null
[ "$(wg show wg0 peers | wc -l)" -eq 1 ] || fail "re-run lost the peer"
cx ping -c 1 -W 2 "$GAME" >/dev/null || fail "tunnel broke after re-run"
pass "re-run keeps peers and the live tunnel"

rig-relay-refresh 2>&1 | grep -q unchanged || fail "refresh with same list should be a no-op"
pass "refresh is a no-op when prefixes are unchanged"

rig-relay-add-peer --remove toaster
[ "$(wg show wg0 peers | wc -l)" -eq 0 ] || fail "peer not removed"
pass "remove peer"

echo "all relay e2e checks passed"
