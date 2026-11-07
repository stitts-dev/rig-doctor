# Rig Doctor relay

Turns a fresh Ubuntu 24.04 VPS into a WireGuard game relay. Client traffic to
Riot game servers (AS6507) enters the tunnel and exits from the relay with NAT.
The relay drops every other destination, so it cannot be used as a general VPN.

What `setup.sh` does:

1. Installs `wireguard-tools`, `nftables`, `jq`, `curl`, `python3`.
2. Enables IPv4 forwarding.
3. Generates the relay keypair once (`/etc/rig-relay/server.key`).
4. Fetches the IPv4 prefixes AS6507 announces from [RIPEstat](https://stat.ripe.net/docs/data-api/announced-prefixes) and collapses them.
5. Loads an nftables table `inet rig_relay`: tunnel traffic may only exit to those prefixes, clients cannot reach relay services (SSH included) except ping, and tunnel traffic is masqueraded on the WAN interface.
6. Brings up `wg0` (tunnel `10.66.0.0/16`, about 65,000 players, relay `10.66.66.1`, UDP 51820) via `wg-quick@wg0`, and opens the port in ufw if ufw is active.
7. Installs a daily timer that refreshes the prefix list. A failed or suspiciously short fetch keeps the old list.
8. Starts the relay API (`rig-relay-api.service`, HTTPS on TCP 51821) so players can join with an invite instead of SSH. See [Invite a player](#invite-a-player).
9. Hardens the host (skip with `--no-harden`):
   - Firewall table `inet rig_relay_host` on the WAN interface (IPv4 and IPv6): only SSH, the WireGuard port, the API port, ping/ICMPv6 and DHCP replies get in. Loaded at boot by `rig-relay-host-firewall.service`.
   - Unattended security upgrades on (no automatic reboots).
   - Key-only SSH (`PermitRootLogin prohibit-password`, no passwords) via `/etc/ssh/sshd_config.d/10-rig-relay.conf`. Skipped with a warning if no SSH key is installed, so it cannot lock you out.

Re-running is safe. Keys and peers are kept, config is regenerated, and peer or
tunnel network changes are applied to the running `wg0` without dropping
players. `wg0` restarts only when it is down or its key or port changed.

## Run it

On the VPS, as a sudo user:

```bash
git clone https://github.com/stitts-dev/rig-doctor.git ~/rig-doctor
sudo ~/rig-doctor/relay/setup.sh
```

From another machine (for example Toaster), with root SSH by key:

```bash
ssh root@<relay-ip> 'git clone https://github.com/stitts-dev/rig-doctor.git ~/rig-doctor 2>/dev/null || git -C ~/rig-doctor pull --ff-only; ~/rig-doctor/relay/setup.sh'
ssh root@<relay-ip> 'rig-relay-add-peer toaster' > toaster.conf
```

Options:

| Flag | Default | Use |
|---|---|---|
| `--endpoint HOST` | IPv4 of the WAN interface | Address clients connect to (IP or DNS name). |
| `--port N` | `51820` | WireGuard UDP port. |
| `--wan IFACE` | interface of the default route | Interface traffic exits on. |
| `--asn N` | `6507` | ASN whose prefixes are allowed. |
| `--prefix-file FILE` | none | Use a local CIDR list instead of RIPEstat. |
| `--api-port N` | `51821` | Relay API TCP port. |
| `--ssh-port N[,N]` | ports from `sshd -T` | SSH ports the host firewall allows. |
| `--no-harden` | off | Skip the host firewall, unattended upgrades and SSH changes. |

If the VPS provider has its own firewall (Vultr Firewall Group), allow UDP 51820 and TCP 51821 there too.

## Invite a player

```bash
sudo rig-relay-invite alice            # one-time invite, valid 24 h (--hours 1-168)
```

Send the printed `rigrelay1.…` line to the player. In Rig Doctor they paste it
under Relays, or run `rig-doctor-globe --relay join INVITE`. The app makes the
player's WireGuard key on their PC, enrolls the public key, and saves the
config. Before each Connect it fetches the current config, so new game
prefixes reach the player without a re-import.

The invite holds the API address, the relay's TLS certificate (the app pins
it, so no domain or CA is needed), the relay's WireGuard key, and a 256-bit
secret. It holds no private key, but anyone who has it can join once, so send
it privately. The relay stores only SHA-256 hashes of invite secrets and device
tokens.

API (all but enroll need `Authorization: Bearer <device token>`):

| Call | Does |
|---|---|
| `POST /v1/enroll {invite, public_key}` | Adds the peer. Returns `config` (with a `<client private key>` placeholder), `prefix_version`, `token`. |
| `GET /v1/config` | Current config and `prefix_version`. |
| `GET /v1/health` | `wg_up`, peer count, prefix count and version, and this player's last handshake and bytes. |
| `DELETE /v1/peer` | Removes this player's peer and token. |

`sudo rig-relay-add-peer --remove alice` revokes a player and their token.
Peers added over SSH with a relay-made key are not served by the API.

## Add a client

```bash
sudo rig-relay-add-peer toaster > toaster.conf
```

This prints a split-tunnel client config: only the game prefixes (and the
relay's tunnel address, for ping) go through
the relay. The relay generates the client key. To keep the private key on the
client instead, generate it there and pass the public key:

```bash
sudo rig-relay-add-peer toaster --pubkey '<client public key>'
```

Other commands:

```bash
sudo rig-relay-add-peer --show toaster     # print the config again (current prefixes)
sudo rig-relay-add-peer --remove toaster   # revoke
sudo wg show wg0                           # handshakes and traffic per peer
sudo nft list table inet rig_relay         # rules and drop counters
sudo rig-relay-refresh                     # refresh prefixes now
```

Copy the config to the client over SSH, not chat or email: it holds the client's
private key. On Windows, import it in the WireGuard app.

When the prefix list changes, the relay updates itself, but client configs
carry the list in `AllowedIPs`. Re-export with `--show` to pick up new ranges.

## Notes

- IPv4 only. AS6507's IPv6 range is not routed through the tunnel.
- Some Riot services (login, patching, store) are on third-party clouds, not
  AS6507. They stay on the client's direct connection, which is intended.
- Files: `/etc/rig-relay/` (keys, peers, prefix list, generated firewall),
  `/etc/wireguard/wg0.conf` (generated), `/usr/local/lib/rig-relay/` (scripts).

## Test

`tests/relay/test_api.py` tests the API and invites with stand-ins for
WireGuard. `tests/relay/e2e.sh` runs in CI (`relay-ci` workflow) on a throwaway Ubuntu
24.04 runner. It runs `setup.sh` twice, connects a client from a network
namespace, and checks that game traffic exits NATed, non-game traffic is
dropped, relay services are closed, peers survive a re-run, the WAN firewall
allows only SSH, WireGuard and the API, SSH is key-only, unattended upgrades
are on, and a player enrolled by invite with their own key plays through the
relay, gets refreshed prefixes, and loses access on self or admin revoke.
