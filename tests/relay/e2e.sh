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
# Start as a relay set up before the tunnel network widened (10.66.66.0/24),
# so the migration below runs against a live tunnel.
export RIG_RELAY_SUBNET=10.66.66.0/24
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

# ---------- widen 10.66.66.0/24 to 10.66.0.0/16 without dropping the player ----------
unset RIG_RELAY_SUBNET
ifindex=$(cat /sys/class/net/wg0/ifindex)
# A background job ignores SIGINT in a script, so ping runs to a deadline that
# covers the whole setup run instead of being stopped.
cx ping -n -q -i 0.1 -w 60 "$GAME" >"$WORK/migrate-ping.log" 2>&1 &
ping_pid=$!
sleep 1
"$REPO/relay/setup.sh" 2>"$WORK/migrate.log" || fail "migration run: $(cat "$WORK/migrate.log")"
wait "$ping_pid" || true
grep -q 'applied in place' "$WORK/migrate.log" || fail "migration restarted wg0: $(cat "$WORK/migrate.log")"
[ "$(cat /sys/class/net/wg0/ifindex)" = "$ifindex" ] || fail "wg0 was recreated"
[ "$(ip -4 -o addr show dev wg0 | awk '{print $4}')" = 10.66.66.1/16 ] || fail "wg0 address: $(ip -4 -o addr show dev wg0)"
grep -q ' 0% packet loss' "$WORK/migrate-ping.log" || fail "player lost packets: $(tail -n 3 "$WORK/migrate-ping.log")"
nft list chain inet rig_relay forward | grep -q 'ip saddr 10.66.0.0/16' || fail "firewall not widened"
grep -q '^Address = 10.66.66.1/16$' /etc/wireguard/wg0.conf || fail "wg0.conf not widened"
cmp -s "$WORK/rrc.conf" <(rig-relay-add-peer --show toaster 2>/dev/null) || fail "existing client config changed"
"$REPO/relay/setup.sh" 2>"$WORK/rerun2.log"
grep -q 'unchanged' "$WORK/rerun2.log" || fail "second run after migration was not a no-op"
pass "tunnel network widens in place with no packet loss and no client change"

# Fill the old /24; the next player gets an address outside it and plays.
for i in $(seq 3 254); do echo "10.66.66.$i" >"/etc/rig-relay/clients/fill$i.ip"; done
rig-relay-add-peer far >"$WORK/far.conf" 2>/dev/null
grep -q '^Address = 10.66.67.1/32$' "$WORK/far.conf" || fail "254th player address: $(grep Address "$WORK/far.conf")"
rm -f /etc/rig-relay/clients/fill*.ip
cx wg-quick down "$WORK/rrc.conf"
chmod 600 "$WORK/far.conf"
cx wg-quick up "$WORK/far.conf"
cx ping -c 2 -W 2 10.66.66.1 >/dev/null || fail "player outside the old /24 cannot ping the relay"
seen=$(wc -l <"$WORK/game.log")
cx curl -fsS --max-time 5 "http://$GAME:8080/" >/dev/null || fail "player outside the old /24: game traffic does not pass"
tail -n +"$((seen + 1))" "$WORK/game.log" | grep -q '^192\.0\.2\.1 ' || fail "far player not NATed: $(cat "$WORK/game.log")"
cx wg-quick down "$WORK/far.conf"
rig-relay-add-peer --remove far
cx wg-quick up "$WORK/rrc.conf"
pass "player 254 gets an address outside the old /24 and plays"

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

# Billing suspends a player whose trial or subscription ended: off wg0, token kept.
rig-relay-add-peer --suspend player2
[ -e /etc/rig-relay/clients/player2.suspended ] || fail "suspend left no marker"
wg show wg0 peers >"$WORK/peers.txt"
! grep -qF "$p2pub" "$WORK/peers.txt" || fail "suspended peer still on wg0"
! grep -qF "$p2pub" /etc/wireguard/wg0.conf || fail "suspended peer still in wg0.conf"
! cx ping -c 1 -W 2 "$GAME" >/dev/null 2>&1 || fail "suspended player still reaches the game"
api -f -H "Authorization: Bearer $token" https://172.30.0.1:51821/v1/config >/dev/null || fail "suspended player lost the API"
rig-relay-add-peer --resume player2
wg show wg0 peers >"$WORK/peers.txt"
grep -qF "$p2pub" "$WORK/peers.txt" || fail "resumed peer not on wg0"
# The client re-handshakes once its old session goes unanswered (about 15 s).
ok=0
for _ in $(seq 40); do cx ping -c 1 -W 1 "$GAME" >/dev/null 2>&1 && { ok=1; break; }; done
[ "$ok" = 1 ] || fail "resumed player: game traffic does not pass"
pass "suspend takes a player off the tunnel and keeps the token, resume brings them back"

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

# Gain table under the real service sandbox: the report lands in /etc/rig-relay/api/gain, named by
# HMAC, and the table counts it. Documentation AS number (RFC 5398).
gain='{"v":1,"game":"league","source":"in_game","asn":64496,"region":"Illinois, United States","direct_ms":44,"relay_ms":31,"direct_loss":0,"relay_loss":0,"direct_n":3,"relay_n":3}'
api -f -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$gain" \
  https://172.30.0.1:51821/v1/gain >"$WORK/gain.json" || fail "gain report refused"
api -f -H "Authorization: Bearer $token" 'https://172.30.0.1:51821/v1/gain?asn=64496' >"$WORK/table.json" || fail "gain table fetch"
jq -e '.rows[0] | .players == 1 and .median_gain_ms == 13 and .gaining == 1 and .region == null' "$WORK/table.json" >/dev/null ||
  fail "gain table: $(cat "$WORK/table.json")"
[ "$(find /etc/rig-relay/api/gain -name '*.json' | wc -l)" -eq 1 ] || fail "gain report not stored once"
! grep -rq player2 /etc/rig-relay/api/gain || fail "gain report names the player"
pass "gain report stored without the player's name and counted in the table"

code=$(api -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $token" https://172.30.0.1:51821/v1/peer)
[ "$code" = 204 ] || fail "self-revoke: got $code"
[ "$(wg show wg0 peers | wc -l)" -eq 0 ] || fail "self-revoke left the peer"
code=$(api -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" https://172.30.0.1:51821/v1/config)
[ "$code" = 401 ] || fail "revoked token still works: $code"
cx wg-quick down "$WORK/rrp.conf"
[ -z "$(find /etc/rig-relay/api/gain -name '*.json')" ] || fail "leaving kept the player's gain report"
pass "a player can revoke their own peer, which deletes their gain report"

decode_invite "$(rig-relay-invite player3)" "$WORK/inv"
body=$(jq -nc --arg i "$(cat "$WORK/inv.secret")" --arg k "$p2pub" '{invite: $i, public_key: $k}')
token=$(api -f -X POST -H 'Content-Type: application/json' -d "$body" https://172.30.0.1:51821/v1/enroll | jq -r .token)
rig-relay-add-peer --remove player3
code=$(api -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" https://172.30.0.1:51821/v1/health)
[ "$code" = 401 ] || fail "admin revoke left the token working: $code"
pass "admin revoke also revokes the API token"

# A signup code: many players, generated names, a trial each. No Stripe keys here, so billing is off.
decode_invite "$(rig-relay-invite --signup chicago --uses 2)" "$WORK/inv"
[ "$(cat "$WORK/inv.name")" = chicago ] || fail "signup code label: $(cat "$WORK/inv.name")"
for n in 1 2; do
  body=$(jq -nc --arg i "$(cat "$WORK/inv.secret")" --arg k "$p2pub" '{invite: $i, public_key: $k}')
  api -f -X POST -H 'Content-Type: application/json' -d "$body" https://172.30.0.1:51821/v1/enroll >"$WORK/signup$n.json" ||
    fail "signup $n failed"
  sname=$(jq -r .name "$WORK/signup$n.json")
  [[ $sname =~ ^p-[0-9a-f]{8}$ ]] || fail "signup peer name: $sname"
  [ -s "/etc/rig-relay/billing/accounts/$sname.json" ] || fail "signup made no trial account"
  api -f -H "Authorization: Bearer $(jq -r .token "$WORK/signup$n.json")" https://172.30.0.1:51821/v1/billing >"$WORK/billing.json" ||
    fail "billing status"
  jq -e '.enabled == false and .state == "trial" and .entitled' "$WORK/billing.json" >/dev/null || fail "billing: $(cat "$WORK/billing.json")"
  rig-relay-add-peer --remove "$sname"
done
code=$(api -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$body" https://172.30.0.1:51821/v1/enroll)
[ "$code" = 403 ] || fail "used-up signup code: got $code, want 403"
pass "a signup code makes trial players up to its limit"

echo "all relay e2e checks passed"
