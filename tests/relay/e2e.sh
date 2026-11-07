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
# Key-only SSH is applied only when the user running setup has a key.
SSH_USER=${SUDO_USER:-root}
SSH_DIR="$(getent passwd "$SSH_USER" | cut -d: -f6)/.ssh"
if ! grep -qs 'ssh-ed25519 AAAA' "$SSH_DIR/authorized_keys"; then
  mkdir -p "$SSH_DIR" && chmod 700 "$SSH_DIR"
  ssh-keygen -q -t ed25519 -N '' -f "$WORK/id_test"
  # Option-prefixed, as setup must accept that form.
  echo "no-pty $(cat "$WORK/id_test.pub")" >>"$SSH_DIR/authorized_keys"
  chown -R "$SSH_USER:" "$SSH_DIR"
fi
# 2222 stands in for SSH so the host firewall test does not depend on sshd.
"$REPO/relay/setup.sh" --wan rr-wan --endpoint 172.30.0.1 --prefix-file "$WORK/prefixes.txt" --ssh-port 2222
pass "setup.sh first run"

mkdir -p /run/sshd
sshd -T | grep -qx 'passwordauthentication no' || fail "ssh still allows passwords"
sshd -T | grep -qxE 'permitrootlogin (without|prohibit)-password' || fail "root password login not disabled"
pass "ssh is key-only"

apt-config dump | grep -q 'APT::Periodic::Unattended-Upgrade "1"' || fail "unattended upgrades off"
pass "unattended upgrades on"

systemctl is-enabled -q rig-relay-host-firewall.service || fail "host firewall not enabled at boot"
python3 -m http.server --bind 0.0.0.0 2222 >/dev/null 2>&1 &
python3 -m http.server --bind 0.0.0.0 8082 >/dev/null 2>&1 &
sleep 1
ip netns exec rr-inet curl -fsS --max-time 3 http://192.0.2.1:2222/ >/dev/null || fail "ssh port closed on WAN"
! ip netns exec rr-inet curl -fsS --max-time 3 http://192.0.2.1:8082/ >/dev/null || fail "non-ssh port open on WAN"
ip netns exec rr-inet ping -c 1 -W 2 192.0.2.1 >/dev/null || fail "ping to WAN blocked"
pass "host firewall allows only ssh and wireguard on WAN"

"$REPO/relay/setup.sh" 2>"$WORK/rerun.log"
grep -q 'unchanged' "$WORK/rerun.log" || fail "re-run regenerated wg0.conf: $(cat "$WORK/rerun.log")"
[ "$(nft list tables | grep -cx "table inet rig_relay")" -eq 1 ] || fail "duplicate relay nft tables"
[ "$(nft list tables | grep -cx "table inet rig_relay_host")" -eq 1 ] || fail "duplicate host nft tables"
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

# ---------- relay API: invite, enroll with a client-made key, refresh, revoke ----------
cx wg-quick down "$WORK/rrc.conf"
systemctl is-active -q rig-relay-api.service || fail "relay API not running: $(journalctl -u rig-relay-api -n 20 --no-pager)"
for _ in $(seq 20); do cx bash -c 'exec 3<>/dev/tcp/172.30.0.1/51821' 2>/dev/null && break; sleep 0.5; done
code=$(ip netns exec rr-inet curl -sk -o /dev/null -w '%{http_code}' --max-time 3 https://192.0.2.1:51821/v1/health || true)
[ "$code" = 401 ] || fail "API port on WAN: got $code, want 401"
pass "relay API is up, open on WAN, and needs a token"

# Decodes an invite into the files a client needs: secret, CA cert, relay key, API URL.
decode_invite() {
  python3 -I - "$1" "$2" <<'PY'
import base64, json, ssl, sys
tok, out = sys.argv[1], sys.argv[2]
b = tok.split(".", 1)[1]
inv = json.loads(base64.urlsafe_b64decode(b + "=" * (-len(b) % 4)))
open(out + ".pem", "w").write(ssl.DER_cert_to_PEM_cert(base64.b64decode(inv["cert"])))
for k in ("secret", "relay_key", "api", "name"):
    open(f"{out}.{k}", "w").write(inv[k])
PY
}
api() { cx curl -sS --cacert "$WORK/inv.pem" --max-time 5 "$@"; }

invite=$(rig-relay-invite player2)
decode_invite "$invite" "$WORK/inv"
[ "$(cat "$WORK/inv.api")" = https://172.30.0.1:51821 ] || fail "invite API URL: $(cat "$WORK/inv.api")"
cmp -s "$WORK/inv.relay_key" <(tr -d '\n' </etc/rig-relay/server.pub) || fail "invite relay key"
wg genkey >"$WORK/p2.key"
p2pub=$(wg pubkey <"$WORK/p2.key")
body=$(jq -nc --arg i "$(cat "$WORK/inv.secret")" --arg k "$p2pub" '{invite: $i, public_key: $k}')
api -f -X POST -H 'Content-Type: application/json' -d "$body" https://172.30.0.1:51821/v1/enroll >"$WORK/enroll.json" ||
  fail "enroll failed"
token=$(jq -r .token "$WORK/enroll.json")
jq -r .config "$WORK/enroll.json" | grep -q '^PrivateKey = <client private key>$' || fail "enroll returned a private key"
[ ! -e /etc/rig-relay/clients/player2.key ] || fail "relay kept a private key for an API peer"
grep -q "$p2pub" /etc/rig-relay/peers/player2.conf || fail "peer not added with the client's key"
pass "enroll adds the peer with the client's own key"

code=$(api -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$body" https://172.30.0.1:51821/v1/enroll)
[ "$code" = 403 ] || fail "invite reuse: got $code, want 403"
pass "an invite works once"

jq -r .config "$WORK/enroll.json" | sed "s|^PrivateKey = .*|PrivateKey = $(cat "$WORK/p2.key")|" >"$WORK/rrp.conf"
chmod 600 "$WORK/rrp.conf"
cx wg-quick up "$WORK/rrp.conf"
cx ping -c 2 -W 2 "$GAME" >/dev/null || fail "API-enrolled client: game traffic does not pass"
pass "API-enrolled client plays through the relay"

v1=$(jq -r .prefix_version "$WORK/enroll.json")
echo 198.18.0.0/15 >>"$WORK/prefixes.txt"
rig-relay-refresh 2>/dev/null
api -f -H "Authorization: Bearer $token" https://172.30.0.1:51821/v1/config >"$WORK/config.json" || fail "config fetch"
[ "$(jq -r .prefix_version "$WORK/config.json")" != "$v1" ] || fail "prefix version did not change after refresh"
jq -r .config "$WORK/config.json" | grep -q '198.18.0.0/15' || fail "refreshed config lacks the new prefix"
pass "config endpoint serves the refreshed prefix list"

api -f -H "Authorization: Bearer $token" https://172.30.0.1:51821/v1/health >"$WORK/health.json" || fail "health fetch"
jq -e '.wg_up and .peers == 1 and .you.latest_handshake > 0' "$WORK/health.json" >/dev/null ||
  fail "health: $(cat "$WORK/health.json")"
pass "health reports the tunnel and this player's handshake"

code=$(api -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $token" https://172.30.0.1:51821/v1/peer)
[ "$code" = 204 ] || fail "self-revoke: got $code"
[ "$(wg show wg0 peers | wc -l)" -eq 0 ] || fail "self-revoke left the peer"
code=$(api -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" https://172.30.0.1:51821/v1/config)
[ "$code" = 401 ] || fail "revoked token still works: $code"
cx wg-quick down "$WORK/rrp.conf"
pass "a player can revoke their own peer"

decode_invite "$(rig-relay-invite player3)" "$WORK/inv"
body=$(jq -nc --arg i "$(cat "$WORK/inv.secret")" --arg k "$p2pub" '{invite: $i, public_key: $k}')
token=$(api -f -X POST -H 'Content-Type: application/json' -d "$body" https://172.30.0.1:51821/v1/enroll | jq -r .token)
rig-relay-add-peer --remove player3
code=$(api -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" https://172.30.0.1:51821/v1/health)
[ "$code" = 401 ] || fail "admin revoke left the token working: $code"
pass "admin revoke also revokes the API token"

echo "all relay e2e checks passed"
