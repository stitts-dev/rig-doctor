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
6. Brings up `wg0` (tunnel `10.66.66.0/24`, relay `.1`, UDP 51820) via `wg-quick@wg0`, and opens the port in ufw if ufw is active.
7. Installs a daily timer that refreshes the prefix list. A failed or suspiciously short fetch keeps the old list.

Re-running is safe. Keys and peers are kept, config is regenerated, and `wg0`
restarts only when its config changed.

## Run it

On the VPS, as a sudo user:

```bash
git clone https://github.com/stitts-dev/rig-doctor.git ~/rig-doctor
sudo ~/rig-doctor/relay/setup.sh
```

Options:

| Flag | Default | Use |
|---|---|---|
| `--endpoint HOST` | IPv4 of the WAN interface | Address clients connect to (IP or DNS name). |
| `--port N` | `51820` | WireGuard UDP port. |
| `--wan IFACE` | interface of the default route | Interface traffic exits on. |
| `--asn N` | `6507` | ASN whose prefixes are allowed. |
| `--prefix-file FILE` | none | Use a local CIDR list instead of RIPEstat. |

If the VPS provider has its own firewall (Vultr Firewall Group), allow UDP 51820 there too.

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

`tests/relay/e2e.sh` runs in CI (`relay-ci` workflow) on a throwaway Ubuntu
24.04 runner. It runs `setup.sh` twice, connects a client from a network
namespace, and checks that game traffic exits NATed, non-game traffic is
dropped, relay services are closed, and peers survive a re-run.
