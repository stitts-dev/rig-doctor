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

    # Documentation AS numbers (RFC 5398), so no real network is named.
    def gain(self, asn, direct, relay, source="in_game", region=None, dn=4, rn=4, **extra):
        return dict({"v": 1, "game": "league", "source": source, "asn": asn, "region": region, "direct_ms": direct,
                     "relay_ms": relay, "direct_loss": 0.001, "relay_loss": 0, "direct_n": dn, "relay_n": rn}, **extra)

    def gain_files(self):
        d = os.path.join(self.conf, "api", "gain")
        return set(os.listdir(d)) if os.path.isdir(d) else set()

    def test_gain_table_by_network_and_region(self):
        before = self.gain_files()
        toks = [self.enroll(n)[1]["token"] for n in ("gain-a", "gain-b", "gain-c")]
        status, r = self.call("POST", "/v1/gain", self.gain(64496, 45, 30, region="Pennsylvania, United States"), token=toks[0])
        self.assertEqual(status, 200, r)
        self.assertEqual((r["asn"], r["bar_ms"]), (64496, 10))
        self.assertEqual(r["rows"][0], {"source": "in_game", "asn": 64496, "region": None, "players": 1, "median_gain_ms": 15.0,
                                        "gaining": 1, "median_direct_ms": 45.0, "median_relay_ms": 30.0})
        self.call("POST", "/v1/gain", self.gain(64496, 40, 38, region="Ohio, United States"), token=toks[1])
        self.call("POST", "/v1/gain", self.gain(64496, 50, 30.5), token=toks[2])
        # A player's new report replaces the old one.
        status, r = self.call("POST", "/v1/gain", self.gain(64496, 44, 30, region="Pennsylvania, United States"), token=toks[0])
        rows = {(x["source"], x["region"]): x for x in r["rows"]}
        whole = rows[("in_game", None)]
        self.assertEqual((whole["players"], whole["median_gain_ms"], whole["gaining"]), (3, 14.0, 2))
        self.assertEqual(rows[("in_game", "Pennsylvania, United States")]["players"], 1)
        self.assertEqual([x["region"] for x in r["rows"]], [None, "Ohio, United States", "Pennsylvania, United States"])
        # Estimates are a separate source, never mixed into the in-game numbers.
        self.call("POST", "/v1/gain", self.gain(64496, 41, 30, source="estimate", dn=5, rn=0), token=toks[0])
        status, t = self.call("GET", "/v1/gain?game=league&asn=64496", token=toks[1])
        self.assertEqual(status, 200, t)
        self.assertEqual([(x["source"], x["region"], x["players"]) for x in t["rows"]],
                         [("estimate", None, 1), ("in_game", None, 3), ("in_game", "Ohio, United States", 1), ("in_game", "Pennsylvania, United States", 1)])
        status, t = self.call("GET", "/v1/gain", token=toks[1])
        self.assertTrue(all(x["asn"] == 64496 for x in t["rows"] if x["source"] == "in_game" and x["region"] is None and x["players"] == 3))
        self.assertEqual(self.call("GET", "/v1/gain?asn=64497", token=toks[1])[1]["rows"], [])
        for q in ("?asn=x", "?asn=0", "?asn=99999999999", "?game=Bad!", "?asn=%C2%B2"):
            self.assertEqual(self.call("GET", "/v1/gain" + q, token=toks[1])[0], 400, q)
        # Stored under an HMAC of the player name: no name, token or address in the files.
        files = self.gain_files() - before
        self.assertEqual(len(files), 3)
        for f in files:
            with open(os.path.join(self.conf, "api", "gain", f)) as fh:
                text = fh.read()
            self.assertNotRegex(f + text, r"gain-[abc]|127\.0\.0\.1")
            for tok in toks:
                self.assertNotIn(tok, text)
        # Leaving the relay deletes the player's reports.
        self.assertEqual(self.call("DELETE", "/v1/peer", token=toks[2])[0], 204)
        rows = self.call("GET", "/v1/gain?asn=64496", token=toks[0])[1]["rows"]
        self.assertEqual(next(x for x in rows if x["source"] == "in_game" and x["region"] is None)["players"], 2)
        self.assertEqual(len(self.gain_files() - before), 2)

    def test_gain_estimate_with_an_invite(self):
        inv = self.invite("gain-tester")
        status, r = self.call("POST", "/v1/gain", self.gain(64500, 52, 30, source="estimate", dn=3, rn=0), token=inv["secret"])
        self.assertEqual(status, 200, r)
        self.assertEqual([(x["source"], x["players"], x["gaining"]) for x in r["rows"]], [("estimate", 1, 1)])
        # The invite only sends estimates: no in-game results (it has never used the relay), no table,
        # no config, and it still works for joining.
        self.assertEqual(self.call("POST", "/v1/gain", self.gain(64500, 52, 30), token=inv["secret"])[0], 403)
        self.assertEqual(self.call("GET", "/v1/gain", token=inv["secret"])[0], 401)
        self.assertEqual(self.call("GET", "/v1/config", token=inv["secret"])[0], 401)
        status, body = self.call("POST", "/v1/enroll", {"invite": inv["secret"], "public_key": KEY})
        self.assertEqual(status, 200, body)
        # Joined, the same player's reports stay one file; a used invite reports nothing more.
        self.call("POST", "/v1/gain", self.gain(64500, 50, 30, source="estimate", dn=3, rn=0), token=body["token"])
        rows = self.call("GET", "/v1/gain?asn=64500", token=body["token"])[1]["rows"]
        self.assertEqual([(x["players"], x["median_gain_ms"]) for x in rows], [(1, 20.0)])
        self.assertEqual(self.call("POST", "/v1/gain", self.gain(64500, 50, 30, source="estimate", dn=3, rn=0), token=inv["secret"])[0], 401)
        # An expired invite reports nothing.
        import hashlib
        old = self.invite("gain-late")
        write(os.path.join(self.conf, "api", "invites", hashlib.sha256(old["secret"].encode()).hexdigest() + ".json"),
              json.dumps({"name": "gain-late", "expires": 1}), 0o600)
        self.assertEqual(self.call("POST", "/v1/gain", self.gain(64500, 50, 30, source="estimate", dn=3, rn=0), token=old["secret"])[0], 401)

    def test_gain_rejects_bad_reports(self):
        token = self.enroll("gain-bad")[1]["token"]
        self.assertEqual(self.call("POST", "/v1/gain", self.gain(64501, 40, 30))[0], 401)
        self.assertEqual(self.call("POST", "/v1/gain", self.gain(64501, 40, 30), token="x" * 43)[0], 401)
        bad = [
            {"v": 2}, {"game": "League"}, {"source": "probe"}, {"asn": 0}, {"asn": True}, {"asn": "64501"}, {"asn": 2 ** 32},
            {"direct_ms": 0}, {"relay_ms": 1001}, {"direct_ms": "40"}, {"direct_loss": 1.5}, {"relay_loss": -0.1},
            {"region": "<b>"}, {"region": " Ohio"}, {"region": "x" * 65}, {"region": "a\nb"}, {"region": 5},
            {"direct_n": 2}, {"relay_n": 2.5}, {"direct_n": 10001},
        ]
        for patch in bad:
            body = dict(self.gain(64501, 40, 30), **patch)
            self.assertEqual(self.call("POST", "/v1/gain", body, token=token)[0], 400, patch)
        # Estimates rest on in-game direct ping (1+ match); in-game reports on 3+ matches per path.
        self.assertEqual(self.call("POST", "/v1/gain", self.gain(64501, 40, 30, source="estimate", dn=0, rn=0), token=token)[0], 400)
        self.assertEqual(self.call("POST", "/v1/gain", self.gain(64501, 40, 30, dn=3, rn=2), token=token)[0], 400)
        self.assertEqual(self.call("POST", "/v1/gain", raw=b'{"v": 1, "direct_ms": NaN}', token=token)[0], 400)
        self.assertEqual(self.call("GET", "/v1/gain?asn=64501", token=token)[1]["rows"], [])
        # One player keeps at most 8 reports (game and source); replacing one is always fine.
        for i in range(8):
            self.assertEqual(self.call("POST", "/v1/gain", self.gain(64501, 40, 30, game=f"g{i}"), token=token)[0], 200, i)
        self.assertEqual(self.call("POST", "/v1/gain", self.gain(64501, 40, 30, game="g8"), token=token)[0], 400)
        self.assertEqual(self.call("POST", "/v1/gain", self.gain(64501, 41, 30, game="g0"), token=token)[0], 200)

    def test_relay_held_key_is_never_served(self):
        _, body = self.enroll("erin")
        write(os.path.join(self.conf, "clients", "erin.key"), "SECRETKEY\n", 0o600)
        status, cfg = self.call("GET", "/v1/config", token=body["token"])
        self.assertEqual(status, 409)
        self.assertNotIn("SECRETKEY", json.dumps(cfg))


class GainUnitTest(unittest.TestCase):
    """GainReports on its own: aging, the 10 ms bar with float sums, damaged files."""

    def setUp(self):
        import importlib.util
        self.tmp = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self.tmp.name, "api"))
        old = os.environ.get("RIG_RELAY_CONF_DIR")
        os.environ["RIG_RELAY_CONF_DIR"] = self.tmp.name
        sys.dont_write_bytecode = True  # no __pycache__ left in relay/
        try:
            spec = importlib.util.spec_from_file_location("relay_api_unit", os.path.join(RELAY, "api.py"))
            self.api = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.api)
        finally:
            if old is None:
                del os.environ["RIG_RELAY_CONF_DIR"]
            else:
                os.environ["RIG_RELAY_CONF_DIR"] = old

    def tearDown(self):
        self.tmp.cleanup()

    def report(self, asn, d, r, region=None):
        return self.api.parse_gain({"v": 1, "game": "league", "source": "in_game", "asn": asn, "region": region, "direct_ms": d,
                                    "relay_ms": r, "direct_n": 3, "relay_n": 3})

    def test_bar_counts_exact_tens_and_old_reports_drop(self):
        g = self.api.GainReports()
        g.save("p1", *self.report(64496, 40.3, 30.3))  # 9.999... in floats, 10.0 rounded
        g.save("p2", *self.report(64496, 30.0, 25.0))
        g.save("p3", *self.report(64496, 50.0, 30.0))
        row = g.rows("league", 64496)[0]
        self.assertEqual((row["players"], row["gaining"], row["median_gain_ms"]), (3, 2, 10.0))
        # A report older than 90 days drops out, after the cache reloads from disk.
        f = os.path.join(self.tmp.name, "api", "gain", self.api.reporter("p3") + ".json")
        with open(f) as fh:
            have = json.load(fh)
        have["league/in_game"]["day"] -= 91
        write(f, json.dumps(have), 0o600)
        self.assertEqual(g.rows("league", 64496)[0]["players"], 3, "cached for a minute")
        g.at -= self.api.GAIN_CACHE_S + 1
        self.assertEqual(g.rows("league", 64496)[0]["players"], 2)

    def test_damaged_files_are_skipped_and_the_key_is_stable(self):
        g = self.api.GainReports()
        g.save("p1", *self.report(64497, 45.0, 30.0, "Ohio, United States"))
        d = os.path.join(self.tmp.name, "api", "gain")
        write(os.path.join(d, "junk.json"), "{not json", 0o600)
        write(os.path.join(d, "list.json"), "[1, 2]", 0o600)
        write(os.path.join(d, "bad.json"), json.dumps({"league/in_game": {"asn": "x"}, "league/estimate": 5}), 0o600)
        fresh = self.api.GainReports()
        self.assertEqual([(r["region"], r["players"]) for r in fresh.rows("league")], [(None, 1), ("Ohio, United States", 1)])
        self.assertEqual(self.api.reporter("p1"), self.api.reporter("p1"))
        self.assertNotEqual(self.api.reporter("p1"), self.api.reporter("p2"))
        self.assertEqual(oct(os.stat(os.path.join(self.tmp.name, "api", "gain.key")).st_mode & 0o777), "0o600")
        fresh.drop("p1")
        self.assertEqual(fresh.rows("league"), [])
        fresh.drop("never-reported")


if __name__ == "__main__":
    unittest.main(verbosity=2)
