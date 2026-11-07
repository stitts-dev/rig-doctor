#!/usr/bin/env bash
# Sets up a Rig Doctor game relay on a fresh Ubuntu 24.04 VPS.
# Safe to re-run: keys and peers are kept, config is regenerated.
#
#   sudo ./relay/setup.sh [--endpoint HOST] [--port 51820] [--wan IFACE]
#                         [--asn 6507] [--prefix-file FILE]
#                         [--ssh-port N] [--no-harden]
set -euo pipefail
SRC_DIR=$(dirname "$(readlink -f "$0")")
# shellcheck source=relay/lib.sh
. "$SRC_DIR/lib.sh"

# Host hardening: WAN firewall, unattended security upgrades, key-only SSH.
harden_host() {
  local ssh_ports=$SSH_PORT
  # Ubuntu 24.04 socket-activates sshd, so its runtime dir may not exist yet.
  mkdir -p /run/sshd
  if [ -z "$ssh_ports" ]; then
    # Union of configured ports, ports sshd is listening on, and ssh.socket's
    # ports (socket activation can listen on ports sshd_config doesn't name).
    ssh_ports=$( {
      sshd -T 2>/dev/null | awk '$1=="port"{print $2}'
      ss -Hltnp 2>/dev/null | awk '/"sshd"/{n=split($4,a,":"); print a[n]}'
      systemctl show ssh.socket -p Listen --value 2>/dev/null |
        grep -oE ':[0-9]+ \(Stream\)' | tr -dc '0-9\n'
    } | grep -E '^[0-9]+$' | sort -un | paste -sd, -)
    [ -n "$ssh_ports" ] || die "could not find the SSH port; pass --ssh-port N or --no-harden"
  fi
  log "host firewall on $WAN: allowing ssh ($ssh_ports/tcp) and ${PORT}/udp only"
  render_host_firewall "$WAN" "$PORT" "$ssh_ports" >"$CONF_DIR/host-firewall.nft"
  nft -c -f "$CONF_DIR/host-firewall.nft" || die "generated host firewall failed nft check"
  cat >/etc/systemd/system/rig-relay-host-firewall.service <<UNIT
[Unit]
Description=Rig Doctor relay host firewall
Wants=network-pre.target
Before=network-pre.target
DefaultDependencies=no

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $CONF_DIR/host-firewall.nft
ExecStop=/usr/sbin/nft delete table inet ${NFT_TABLE}_host

[Install]
WantedBy=sysinit.target
UNIT
  systemctl daemon-reload
  systemctl enable rig-relay-host-firewall.service >/dev/null 2>&1
  nft -f "$CONF_DIR/host-firewall.nft"

  log "enabling unattended security upgrades"
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<APT
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT
  systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true

  # Only lock SSH to keys when the user running setup has a key installed, so
  # a run can't lock them out. Keys may carry options before the key type.
  local user=${SUDO_USER:-root} keys
  keys="$(getent passwd "$user" | cut -d: -f6)/.ssh/authorized_keys"
  if [ -s "$keys" ] && grep -vE '^[[:space:]]*(#|$)' "$keys" |
      grep -qE '(^|[[:space:],"])(ssh-(ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9]+|sk-[a-z0-9@.-]+) AAAA'; then
    log "ssh: key-only login"
    cat >/etc/ssh/sshd_config.d/10-rig-relay.conf <<SSHD
# Written by rig-relay setup.sh. Loaded before 50-cloud-init.conf, so it wins.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
SSHD
    sshd -t || { rm -f /etc/ssh/sshd_config.d/10-rig-relay.conf; die "sshd config check failed; ssh left unchanged"; }
    # A running sshd must re-read its config. With socket activation and no
    # running ssh.service, each new connection reads the new config anyway.
    if systemctl is-active -q ssh.service; then
      systemctl reload ssh.service || die "ssh reload failed; password login may still be on"
    fi
  else
    log "warning: no SSH key for $user in $keys; leaving password login as is"
  fi
}

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

require_root
load_env
PORT=${PORT:-51820}
ASN=${ASN:-6507}
PREFIX_SOURCE=${PREFIX_SOURCE:-}
SSH_PORT=${SSH_PORT:-}
HARDEN=${HARDEN:-1}
while [ $# -gt 0 ]; do
  case $1 in
    --endpoint) ENDPOINT=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --wan) WAN=$2; shift 2 ;;
    --asn) ASN=$2; PREFIX_SOURCE=; shift 2 ;;
    --prefix-file) PREFIX_SOURCE=$(readlink -f "$2"); shift 2 ;;
    --ssh-port) SSH_PORT=$2; shift 2 ;;
    --no-harden) HARDEN=0; shift ;;
    -h|--help) usage ;;
    *) log "unknown option: $1"; usage 1 ;;
  esac
done
[[ $PORT =~ ^[0-9]+$ ]] || die "--port must be a number"
[[ $ASN =~ ^[0-9]+$ ]] || die "--asn must be a number"
[[ -z $SSH_PORT || $SSH_PORT =~ ^[0-9]+(,[0-9]+)*$ ]] || die "--ssh-port must be a number"
PREFIX_SOURCE=${PREFIX_SOURCE:-$ASN}

log "installing packages"
pkgs=(wireguard-tools nftables jq curl python3 iproute2 unattended-upgrades)
missing=0
for pkg in "${pkgs[@]}"; do
  [ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null)" = installed ] || missing=1
done
if [ "$missing" = 1 ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -yq --no-install-recommends "${pkgs[@]}"
fi

WAN=${WAN:-$(ip -4 route show default | awk '{for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}')}
[ -n "$WAN" ] || die "no default route; pass --wan IFACE"
ip link show "$WAN" >/dev/null 2>&1 || die "interface $WAN not found"
if [ -z "${ENDPOINT:-}" ]; then
  ENDPOINT=$(ip -4 -o addr show dev "$WAN" scope global | awk '{split($4,a,"/"); print a[1]; exit}')
  [ -n "$ENDPOINT" ] || die "no IPv4 address on $WAN; pass --endpoint HOST"
fi

mkdir -p "$CONF_DIR/peers" "$CONF_DIR/clients"
chmod 0700 "$CONF_DIR" "$CONF_DIR/clients"
cat >"$CONF_DIR/relay.env" <<ENV
# Written by setup.sh. Re-run setup.sh to change.
WAN=$WAN
ENDPOINT=$ENDPOINT
PORT=$PORT
ASN=$ASN
PREFIX_SOURCE=$PREFIX_SOURCE
SSH_PORT=$SSH_PORT
HARDEN=$HARDEN
ENV

log "enabling IPv4 forwarding"
echo 'net.ipv4.ip_forward = 1' >/etc/sysctl.d/99-rig-relay.conf
sysctl -q -p /etc/sysctl.d/99-rig-relay.conf

if [ ! -s "$CONF_DIR/server.key" ]; then
  log "generating relay keypair"
  (umask 077 && wg genkey >"$CONF_DIR/server.key")
fi
wg pubkey <"$CONF_DIR/server.key" >"$CONF_DIR/server.pub"

log "loading game server prefixes from ${PREFIX_SOURCE}"
if ! (update_prefix_file "$PREFIX_SOURCE" "$CONF_DIR/riot4.txt"); then
  [ -s "$CONF_DIR/riot4.txt" ] || die "no prefix list available"
  log "warning: using the previous prefix list"
fi

log "installing scripts to $LIB_DIR"
mkdir -p "$LIB_DIR"
install -m 0755 "$SRC_DIR"/lib.sh "$SRC_DIR"/firewall.sh "$SRC_DIR"/add-peer.sh \
  "$SRC_DIR"/refresh-prefixes.sh "$LIB_DIR"/
ln -sf "$LIB_DIR/add-peer.sh" /usr/local/sbin/rig-relay-add-peer
ln -sf "$LIB_DIR/refresh-prefixes.sh" /usr/local/sbin/rig-relay-refresh

render_firewall "$WAN" "$CONF_DIR/riot4.txt" >"$CONF_DIR/firewall.nft"
nft -c -f "$CONF_DIR/firewall.nft" || die "generated firewall failed nft check"
wg_changed=$(write_wg_conf)

if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  log "ufw is active: allowing ${PORT}/udp"
  ufw allow "${PORT}/udp" comment 'rig-relay wireguard' >/dev/null
fi

log "installing daily prefix refresh timer"
cat >/etc/systemd/system/rig-relay-refresh.service <<UNIT
[Unit]
Description=Refresh Rig Doctor relay game server prefixes
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/rig-relay-refresh
UNIT
cat >/etc/systemd/system/rig-relay-refresh.timer <<UNIT
[Unit]
Description=Daily refresh of Rig Doctor relay game server prefixes

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now rig-relay-refresh.timer >/dev/null 2>&1

systemctl enable "wg-quick@$WG_IF" >/dev/null 2>&1
if [ -n "$wg_changed" ] || ! systemctl is-active -q "wg-quick@$WG_IF"; then
  log "starting $WG_IF"
  systemctl restart "wg-quick@$WG_IF"
else
  log "$WG_IF unchanged; reloading firewall"
  "$LIB_DIR/firewall.sh" up
fi

if [ "$HARDEN" = 1 ]; then
  harden_host
else
  log "skipping host hardening (--no-harden)"
fi

wg show "$WG_IF" >/dev/null || die "$WG_IF is not up"
log "relay ready: endpoint ${ENDPOINT}:${PORT}, $(grep -c . "$CONF_DIR/riot4.txt") game prefixes"
log "add a client: sudo rig-relay-add-peer NAME"
