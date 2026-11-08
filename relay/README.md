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
| `GET /v1/config` | Current config, `prefix_version`, and `game_prefixes` (game server /24s players have seen). |
| `POST /v1/servers {prefixes}` | Adds up to 16 game server /24s seen in matches. Only /24s inside `riot4.txt` are accepted, kept in `game4.txt`. Apps narrow their tunnel (League) to these; the firewall still allows all of `riot4.txt`. |
| `GET /v1/health` | `wg_up`, peer count, prefix count and version, and this player's last handshake and bytes. |
| `DELETE /v1/peer` | Removes this player's peer and token. A subscription ends with it. |
| `GET /v1/billing` | Trial or subscription state, paid months and their refund decisions, months waiting for a verdict. |
| `POST /v1/billing/checkout` | Stripe Checkout link for the subscription. |
| `POST /v1/billing/portal` | Stripe Customer Portal link (card, invoices). |
| `POST /v1/billing/cancel` | Cancels at the end of the paid month. |
| `POST /v1/billing/verdicts {verdicts}` | The app's verdicts for finished months; each settles that month's invoice. |

`sudo rig-relay-add-peer --remove alice` revokes a player and their token.
Peers added over SSH with a relay-made key are not served by the API.

## Billing

Off until Stripe keys are set. Players who joined with a one-time invite are
never billed or suspended.

1. A signup code works for many players. Each pastes it under Join in the app
   and gets a generated peer name and a free trial (7 days, no card):

   ```bash
   sudo rig-relay-invite --signup chicago --uses 50 --hours 720
   ```

   One address can sign up 3 times a day.
2. The app's Subscribe opens Stripe Checkout. Invoices are anchored to the 1st
   of the month (UTC): the first is prorated, each later one covers one
   calendar month. Cancel in the app is one click and ends the subscription at
   the end of the paid month. Manage billing opens the Customer Portal.
3. After a month ends, the app sends its verdict for that month (the rule its
   Proof panel shows). A month without a measured gain is refunded in full
   through the refunds API, once. If no verdict arrives within 3 days of the
   month's end, the month is refunded too.
4. When a trial ends without a subscription, or a subscription ends, the
   player's peer is suspended: it leaves `wg0`, and its token keeps working so
   the app can still subscribe. A payment that fails keeps the peer on while
   Stripe retries.

Stripe can't reach the relay (no domain or CA certificate), so there are no
webhooks. The relay reads Stripe when the app asks for its billing state and
once an hour. Requests pin Stripe API version `2024-06-20`.

Turn it on in Stripe test mode:

1. Create a product with a recurring price of $4.99 per month. Copy the price
   ID (`price_...`).
2. Activate the Customer Portal (Settings, Billing, Customer portal) and allow
   canceling at the end of the billing period.
3. Create a restricted key (`rk_test_...`) with write access to Customers,
   Checkout Sessions, Customer portal, Subscriptions and Refunds, and read
   access to Invoices and Prices. The test secret key (`sk_test_...`) also works.
4. On the relay, write `/etc/rig-relay/billing.env`, then restart the API:

   ```bash
   sudo install -m 600 /dev/null /etc/rig-relay/billing.env
   sudo nano /etc/rig-relay/billing.env
   sudo systemctl restart rig-relay-api
   ```

   ```ini
   STRIPE_SECRET_KEY=rk_test_...
   STRIPE_PRICE_ID=price_...
   # Optional. The page after Checkout and the Portal (default: this repo).
   BILLING_RETURN_URL=https://example.com/thanks
   # Optional defaults: TRIAL_DAYS=7 BILLING_GRACE_DAYS=3 SIGNUP_PER_IP_PER_DAY=3
   ```

Keys stay in that file (mode 600), never in the repo. Accounts are in
`/etc/rig-relay/billing/accounts/NAME.json`. To run the hourly sweep now:

```bash
sudo bash -c 'set -a; . /etc/rig-relay/relay.env; . /etc/rig-relay/billing.env; python3 -I /usr/local/lib/rig-relay/api.py --sweep'
```

Suspend or resume a player by hand with `rig-relay-add-peer --suspend NAME`
and `--resume NAME`. The next sweep puts billed players back in step with
their account.

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

`tests/relay/test_api.py` tests the API, invites, signup codes and billing
with stand-ins for WireGuard and Stripe. `tests/relay/e2e.sh` runs in CI (`relay-ci` workflow) on a throwaway Ubuntu
24.04 runner. It runs `setup.sh` twice, connects a client from a network
namespace, and checks that game traffic exits NATed, non-game traffic is
dropped, relay services are closed, peers survive a re-run, the WAN firewall
allows only SSH, WireGuard and the API, SSH is key-only, unattended upgrades
are on, and a player enrolled by invite with their own key plays through the
relay, loses the tunnel but not the API while suspended, gets refreshed
prefixes, and loses access on self or admin revoke, and that a signup code
makes trial players up to its limit.
