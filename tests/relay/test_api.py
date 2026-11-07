#!/usr/bin/env python3
"""Tests relay/api.py and relay/invite.sh against a temp relay dir.

Hermetic: a fake rig-relay-add-peer and a fake `wg` stand in for WireGuard,
so this runs without root networking. tests/relay/e2e.sh covers the real thing.
Run: sudo python3 -I tests/relay/test_api.py   (invite.sh requires root)
"""
import base64
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RELAY = os.path.join(REPO, "relay")
KEY = "cGxhY2Vob2xkZXJwbGFjZWhvbGRlcnBsYWNlaG9sZGU="

FAKE_ADD_PEER = r"""#!/usr/bin/env bash
# Minimal stand-in for relay/add-peer.sh: same arguments, same files.
set -euo pipefail
d=$RIG_RELAY_CONF_DIR
show() {
  cat <<CONF
[Interface]
PrivateKey = $(cat "$d/clients/$1.key" 2>/dev/null || echo '<client private key>')
Address = $(cat "$d/clients/$1.ip")/32

[Peer]
PublicKey = $(cat "$d/server.pub")
Endpoint = 127.0.0.1:51820
AllowedIPs = 10.66.66.1/32, $(paste -sd, "$d/riot4.txt" | sed 's/,/, /g')
PersistentKeepalive = 25
CONF
}
case $1 in
  --show) show "$2" ;;
  --remove) rm -f "$d/peers/$2.conf" "$d/clients/$2.ip" "$d/clients/$2.key" "$d/clients/$2.token" ;;
  *) n=$(ls "$d/peers" | wc -l); echo "10.66.66.$((n + 2))" >"$d/clients/$1.ip"
     printf '[Peer]\n# %s\nPublicKey = %s\nAllowedIPs = 10.66.66.%s/32\n' "$1" "$3" "$((n + 2))" >"$d/peers/$1.conf"
     show "$1" ;;
esac
"""

FAKE_WG = r"""#!/usr/bin/env bash
# `wg show wg0 dump`: interface line, then one line per peer.
d=$RIG_RELAY_CONF_DIR
printf 'priv\tpub\t51820\toff\n'
for f in "$d"/peers/*.conf; do
  [ -e "$f" ] || continue
  k=$(awk '/^PublicKey/{print $3}' "$f")
  printf '%s\t(none)\t198.51.100.7:4000\t10.66.66.2/32\t1700000000\t1234\t5678\t25\n' "$k"
done
"""


def write(path, text, mode=0o644):
    with open(path, "w") as f:
        f.write(text)
    os.chmod(path, mode)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = cls.d = cls.tmp.name
        conf = os.path.join(d, "etc")
        for sub in ("peers", "clients"):
            os.makedirs(os.path.join(conf, sub))
        bindir = os.path.join(d, "bin")
        os.makedirs(bindir)
        write(os.path.join(bindir, "add-peer"), FAKE_ADD_PEER, 0o755)
        write(os.path.join(bindir, "wg"), FAKE_WG, 0o755)
        cls.port = free_port()
        write(os.path.join(conf, "relay.env"), f"ENDPOINT=127.0.0.1\nPORT=51820\nAPI_PORT={cls.port}\n")
        write(os.path.join(conf, "server.pub"), KEY + "\n")
        write(os.path.join(conf, "riot4.txt"), "198.51.100.0/24\n")
        cls.env = dict(os.environ, RIG_RELAY_CONF_DIR=conf, RIG_RELAY_ADD_PEER=os.path.join(bindir, "add-peer"),
                       API_PORT=str(cls.port), API_BIND="127.0.0.1", PATH=bindir + os.pathsep + os.environ["PATH"])
        cls.conf = conf
        subprocess.run(["bash", "-c", f'. "{RELAY}/lib.sh"; ensure_api_cert 127.0.0.1'], env=cls.env, check=True)
        cls.server = subprocess.Popen([sys.executable, "-I", os.path.join(RELAY, "api.py")], env=cls.env,
                                      stderr=subprocess.PIPE)
        cls.ctx = ssl.create_default_context(cafile=os.path.join(conf, "api", "tls.crt"))
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait()
        cls.server.stderr.close()
        cls.tmp.cleanup()

    def invite(self, name, *extra):
        r = subprocess.run([os.path.join(RELAY, "invite.sh"), name, *extra], env=self.env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        tok = r.stdout.strip()
        self.assertTrue(tok.startswith("rigrelay1."))
        b = tok[len("rigrelay1."):]
        return json.loads(base64.urlsafe_b64decode(b + "=" * (-len(b) % 4)))

    def call(self, method, path, body=None, token=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(f"https://127.0.0.1:{self.port}{path}", data=data, method=method)
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=5) as r:
                text = r.read()
                return r.status, json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def enroll(self, name):
        inv = self.invite(name)
        status, body = self.call("POST", "/v1/enroll", {"invite": inv["secret"], "public_key": KEY})
        self.assertEqual(status, 200, body)
        return inv, body

    def test_invite_contents(self):
        inv = self.invite("inv-only")
        self.assertEqual(inv["v"], 1)
        self.assertEqual(inv["api"], f"https://127.0.0.1:{self.port}")
        self.assertEqual(inv["relay_key"], KEY)
        self.assertEqual(inv["name"], "inv-only")
        cert = ssl.DER_cert_to_PEM_cert(base64.b64decode(inv["cert"]))
        with open(os.path.join(self.conf, "api", "tls.crt")) as f:
            self.assertEqual(cert.strip(), f.read().strip())
        stored = os.listdir(os.path.join(self.conf, "api", "invites"))
        self.assertTrue(stored and all(len(f) == 64 + 5 for f in stored), "invites stored by hash only")
        for f in stored:
            with open(os.path.join(self.conf, "api", "invites", f)) as fh:
                self.assertNotIn(inv["secret"], fh.read())

    def test_invite_refuses_bad_input(self):
        for args in (["Bad_Name"], ["ok", "--hours", "0"], ["ok", "--hours", "999"]):
            r = subprocess.run([os.path.join(RELAY, "invite.sh"), *args], env=self.env, capture_output=True)
            self.assertNotEqual(r.returncode, 0, args)

    def test_enroll_config_health_revoke(self):
        inv, body = self.enroll("alice")
        self.assertEqual(body["name"], "alice")
        self.assertIn("PrivateKey = <client private key>", body["config"])
        self.assertIn(f"PublicKey = {KEY}", body["config"])
        token = body["token"]
        with open(os.path.join(self.conf, "clients", "alice.token")) as f:
            self.assertNotIn(token, f.read(), "token stored hashed")

        # The invite works once.
        status, _ = self.call("POST", "/v1/enroll", {"invite": inv["secret"], "public_key": KEY})
        self.assertEqual(status, 403)

        status, cfg = self.call("GET", "/v1/config", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(cfg["prefix_version"], body["prefix_version"])

        write(os.path.join(self.conf, "riot4.txt"), "198.51.100.0/24\n192.0.2.0/24\n")
        status, cfg = self.call("GET", "/v1/config", token=token)
        self.assertNotEqual(cfg["prefix_version"], body["prefix_version"])
        self.assertIn("192.0.2.0/24", cfg["config"])

        status, h = self.call("GET", "/v1/health", token=token)
        self.assertEqual(status, 200)
        self.assertTrue(h["wg_up"])
        self.assertEqual(h["prefixes"], 2)
        self.assertEqual(h["you"], {"latest_handshake": 1700000000, "rx_bytes": 1234, "tx_bytes": 5678})

        status, _ = self.call("DELETE", "/v1/peer", token=token)
        self.assertEqual(status, 204)
        self.assertFalse(os.path.exists(os.path.join(self.conf, "peers", "alice.conf")))
        status, _ = self.call("GET", "/v1/config", token=token)
        self.assertEqual(status, 401)

    def test_admin_remove_kills_token(self):
        _, body = self.enroll("bob")
        subprocess.run([self.env["RIG_RELAY_ADD_PEER"], "--remove", "bob"], env=self.env, check=True)
        status, _ = self.call("GET", "/v1/health", token=body["token"])
        self.assertEqual(status, 401)

    def test_auth_required(self):
        for path in ("/v1/config", "/v1/health"):
            self.assertEqual(self.call("GET", path)[0], 401)
            self.assertEqual(self.call("GET", path, token="x" * 43)[0], 401)
        self.assertEqual(self.call("DELETE", "/v1/peer")[0], 401)
        self.assertEqual(self.call("GET", "/nope")[0], 404)

    def test_enroll_rejects_bad_requests(self):
        inv = self.invite("carol")
        self.assertEqual(self.call("POST", "/v1/enroll", {"invite": inv["secret"], "public_key": "nope"})[0], 400)
        self.assertEqual(self.call("POST", "/v1/enroll", {"invite": "A" * 43, "public_key": KEY})[0], 403)
        self.assertEqual(self.call("POST", "/v1/enroll", raw=b"[1]")[0], 400)
        self.assertEqual(self.call("POST", "/v1/enroll", raw=b"{" + b" " * 5000 + b"}")[0], 413)
        # A rejected key does not burn the invite.
        self.assertEqual(self.call("POST", "/v1/enroll", {"invite": inv["secret"], "public_key": KEY})[0], 200)

    def test_expired_invite(self):
        import hashlib
        inv = self.invite("dave")
        p = os.path.join(self.conf, "api", "invites", hashlib.sha256(inv["secret"].encode()).hexdigest() + ".json")
        write(p, json.dumps({"name": "dave", "expires": 1}), 0o600)
        self.assertEqual(self.call("POST", "/v1/enroll", {"invite": inv["secret"], "public_key": KEY})[0], 403)

    def test_game_ranges_shared_inside_the_riot_list(self):
        write(os.path.join(self.conf, "riot4.txt"), "198.51.100.0/23\n192.0.2.0/24\n")
        _, body = self.enroll("frank")
        token = body["token"]
        self.assertEqual(body.get("game_prefixes", []), [])
        self.assertEqual(self.call("POST", "/v1/servers", {"prefixes": ["198.51.101.0/24"]})[0], 401)
        status, r = self.call("POST", "/v1/servers", {"prefixes": ["198.51.101.0/24", "192.0.2.0/24"]}, token=token)
        self.assertEqual(status, 200, r)
        self.assertEqual(r["game_prefixes"], ["192.0.2.0/24", "198.51.101.0/24"])
        # Repeats add nothing; the list is shared with every player's config.
        self.call("POST", "/v1/servers", {"prefixes": ["192.0.2.0/24"]}, token=token)
        status, cfg = self.call("GET", "/v1/config", token=token)
        self.assertEqual(cfg["game_prefixes"], ["192.0.2.0/24", "198.51.101.0/24"])
        self.assertEqual(self.call("GET", "/v1/health", token=token)[1]["game_ranges"], 2)
        # Outside the Riot list, not a /24, host bits set, too many, or not a list: refused whole.
        for bad in (["203.0.113.0/24"], ["198.51.100.0/23"], ["198.51.100.5/24"], ["x"], [], ["192.0.2.0/24"] * 17, "192.0.2.0/24"):
            self.assertEqual(self.call("POST", "/v1/servers", {"prefixes": bad}, token=token)[0], 400, bad)
        # A range that leaves the Riot list stops being served.
        write(os.path.join(self.conf, "riot4.txt"), "198.51.100.0/23\n")
        self.assertEqual(self.call("GET", "/v1/config", token=token)[1]["game_prefixes"], ["198.51.101.0/24"])

    def test_relay_held_key_is_never_served(self):
        _, body = self.enroll("erin")
        write(os.path.join(self.conf, "clients", "erin.key"), "SECRETKEY\n", 0o600)
        status, cfg = self.call("GET", "/v1/config", token=body["token"])
        self.assertEqual(status, 409)
        self.assertNotIn("SECRETKEY", json.dumps(cfg))


if __name__ == "__main__":
    unittest.main(verbosity=2)
