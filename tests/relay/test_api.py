#!/usr/bin/env python3
"""Tests relay/api.py, relay/billing.py and relay/invite.sh against a temp relay dir.

Hermetic: a fake rig-relay-add-peer and a fake `wg` stand in for WireGuard, and
a fake Stripe API on localhost stands in for Stripe, so this runs without root
networking or keys. tests/relay/e2e.sh covers the real WireGuard side.
Run: sudo python3 -I tests/relay/test_api.py   (invite.sh requires root)
"""
import base64
import calendar
import hashlib
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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
  --remove) rm -f "$d/peers/$2.conf" "$d/clients/$2.ip" "$d/clients/$2.key" "$d/clients/$2.token" "$d/clients/$2.suspended" ;;
  --suspend) [ -f "$d/peers/$2.conf" ] && touch "$d/clients/$2.suspended" ;;
  --resume) rm -f "$d/clients/$2.suspended" ;;
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


class RelayCase(unittest.TestCase):
    """A temp relay with the API running. Subclasses add environment through EXTRA_ENV."""
    EXTRA_ENV = {}

    @classmethod
    def setUpClass(cls):
        if cls is RelayCase:
            raise unittest.SkipTest("base class")
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
                       API_PORT=str(cls.port), API_BIND="127.0.0.1", PATH=bindir + os.pathsep + os.environ["PATH"],
                       BILLING_SWEEP_SECONDS="0", **cls.extra_env())
        for k in ("STRIPE_SECRET_KEY", "STRIPE_PRICE_ID"):
            if k not in cls.extra_env():
                cls.env.pop(k, None)
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

    @classmethod
    def extra_env(cls):
        return dict(cls.EXTRA_ENV)

    def enroll(self, name):
        inv = self.invite(name)
        status, body = self.call("POST", "/v1/enroll", {"invite": inv["secret"], "public_key": KEY})
        self.assertEqual(status, 200, body)
        return inv, body

    def signup(self, code=None, fresh_ip=True):
        """Enrolls through a signup code. Returns the enroll answer (name, token)."""
        if fresh_ip:
            self.clear_signups()
        code = code or self.invite("--signup", "chicago")
        status, body = self.call("POST", "/v1/enroll", {"invite": code["secret"], "public_key": KEY})
        self.assertEqual(status, 200, body)
        return body

    def clear_signups(self):
        try:
            os.unlink(os.path.join(self.conf, "api", "signups.json"))
        except FileNotFoundError:
            pass

    def acct_file(self, name):
        return os.path.join(self.conf, "billing", "accounts", f"{name}.json")

    def acct(self, name):
        with open(self.acct_file(name)) as f:
            return json.load(f)

    def edit_acct(self, name, **fields):
        a = self.acct(name)
        a.update(fields)
        write(self.acct_file(name), json.dumps(a), 0o600)

    def sweep(self, **env):
        r = subprocess.run([sys.executable, "-I", os.path.join(RELAY, "api.py"), "--sweep"], env={**self.env, **env}, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stderr

    def suspended(self, name):
        return os.path.exists(os.path.join(self.conf, "clients", f"{name}.suspended"))


class ApiTest(RelayCase):
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
        for args in (["Bad_Name"], ["ok", "--hours", "0"], ["ok", "--hours", "999"], ["--signup", "--uses", "0"],
                     ["--signup", "--uses", "10001"], ["--signup", "--hours", "8761"], ["--signup", "Bad_Label"]):
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

    # ---------- signup codes, billing off (no Stripe keys) ----------

    def test_signup_code_makes_trial_players_without_billing(self):
        code = self.invite("--signup", "chicago", "--uses", "2")
        self.assertEqual((code["name"], code["signup"]), ("chicago", True))
        a = self.signup(code)
        b = self.signup(code)
        for body in (a, b):
            self.assertRegex(body["name"], r"^p-[0-9a-f]{8}$")
            self.assertIn("PrivateKey = <client private key>", body["config"])
            self.assertTrue(os.path.exists(os.path.join(self.conf, "peers", f"{body['name']}.conf")))
        self.assertNotEqual(a["name"], b["name"])
        # Used up: the code is gone.
        self.assertEqual(self.call("POST", "/v1/enroll", {"invite": code["secret"], "public_key": KEY})[0], 403)
        status, st = self.call("GET", "/v1/billing", token=a["token"])
        self.assertEqual(status, 200, st)
        self.assertEqual((st["enabled"], st["state"], st["entitled"], st["price"]), (False, "trial", True, None))
        self.assertAlmostEqual(st["trial_ends"], time.time() + 7 * 86400, delta=120)
        # Without keys nothing can be bought, and an ended trial is not cut off.
        self.assertEqual(self.call("POST", "/v1/billing/checkout", {}, token=a["token"])[0], 503)
        self.edit_acct(a["name"], trial_ends=int(time.time()) - 60)
        self.sweep()
        st = self.call("GET", "/v1/billing", token=a["token"])[1]
        self.assertEqual((st["state"], st["entitled"]), ("lapsed", True))
        self.assertFalse(self.suspended(a["name"]))

    def test_signups_per_address_are_capped(self):
        self.clear_signups()
        code = self.invite("--signup", "chicago")
        for _ in range(3):
            self.signup(code, fresh_ip=False)
        status, body = self.call("POST", "/v1/enroll", {"invite": code["secret"], "public_key": KEY})
        self.assertEqual(status, 429, body)
        with open(os.path.join(self.conf, "api", "signups.json")) as f:
            self.assertNotIn("127.0.0.1", f.read(), "addresses are stored hashed")
        # The refused signup did not spend a use.
        with open(os.path.join(self.conf, "api", "invites", hashlib.sha256(code["secret"].encode()).hexdigest() + ".json")) as f:
            self.assertEqual(json.load(f)["uses"], 47)
        self.clear_signups()

    def test_invited_device_has_no_billing(self):
        _, body = self.enroll("ivy")
        st = self.call("GET", "/v1/billing", token=body["token"])[1]
        self.assertEqual((st["state"], st["entitled"], st["can_subscribe"]), ("comp", True, False))
        self.assertFalse(os.path.exists(self.acct_file("ivy")))

    def test_sweep_resumes_everyone_when_billing_is_off(self):
        body = self.signup()
        self.edit_acct(body["name"], suspended=True)
        write(os.path.join(self.conf, "clients", f"{body['name']}.suspended"), "")
        self.assertIn("resumed (billing is off)", self.sweep())
        self.assertFalse(self.suspended(body["name"]))
        self.assertFalse(self.acct(body["name"])["suspended"])


# ---------- billing against a fake Stripe ----------

def month_starts():
    """Unix starts of two months ago, last month, this month and next month (UTC)."""
    t = time.gmtime()
    out = []
    for back in (2, 1, 0, -1):
        y, m = t.tm_year, t.tm_mon - back
        while m < 1:
            y, m = y - 1, m + 12
        while m > 12:
            y, m = y + 1, m - 12
        out.append(calendar.timegm((y, m, 1, 0, 0, 0)))
    return out


def key(ts):
    t = time.gmtime(ts)
    return f"{t.tm_year:04d}-{t.tm_mon:02d}"


class FakeStripe:
    """Just enough of Stripe's REST API for billing.py, in memory, on localhost."""

    SECRET = "sk_test_fake"

    def __init__(self):
        self.lock = threading.Lock()
        self.n = 0
        self.customers, self.subs, self.invoices = {}, {}, {}
        self.sessions, self.portals, self.refunds = [], [], []
        self.idem = {}
        self.fail = False
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def handle_any(self, method):
                u = urllib.parse.urlsplit(self.path)
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n).decode() if n else u.query
                params = {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}
                status, body = fake.route(method, u.path, params, self.headers)
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self.handle_any("GET")

            def do_POST(self):
                self.handle_any("POST")

            def do_DELETE(self):
                self.handle_any("DELETE")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def new_id(self, prefix):
        self.n += 1
        return f"{prefix}_{self.n}"

    def route(self, method, path, p, headers):
        if headers.get("Authorization") != f"Bearer {self.SECRET}":
            return 401, {"error": {"message": "Invalid API Key provided"}}
        if headers.get("Stripe-Version") != "2024-06-20":
            return 400, {"error": {"message": "unpinned API version"}}
        if self.fail:
            return 500, {"error": {"message": "Stripe is down (fake)"}}
        with self.lock:
            k = headers.get("Idempotency-Key")
            if k and k in self.idem:
                return 200, self.idem[k]
            status, body = self.handle(method, path, p)
            if k and status == 200:
                self.idem[k] = body
            if k and path == "/v1/refunds" and status == 200:
                self.refunds[-1]["key"] = k
            return status, body

    def handle(self, method, path, p):
        if method == "POST" and path == "/v1/customers":
            c = {"id": self.new_id("cus"), "metadata": {"rig_peer": p.get("metadata[rig_peer]")}}
            self.customers[c["id"]] = c
            return 200, c
        if method == "GET" and path == "/v1/prices/price_fake":
            return 200, {"id": "price_fake", "unit_amount": 499, "currency": "usd", "recurring": {"interval": "month"}}
        if method == "POST" and path == "/v1/checkout/sessions":
            sid = self.new_id("cs_test")
            self.sessions.append(dict(p, id=sid))
            return 200, {"id": sid, "url": f"https://checkout.stripe.com/c/pay/{sid}"}
        if method == "POST" and path == "/v1/billing_portal/sessions":
            self.portals.append(p)
            return 200, {"id": self.new_id("bps"), "url": f"https://billing.stripe.com/p/session/test_{self.n}"}
        if method == "GET" and path == "/v1/subscriptions":
            return 200, {"object": "list", "data": [s for s in self.subs.values() if s["customer"] == p.get("customer")]}
        m = re.fullmatch(r"/v1/subscriptions/(sub_\d+)", path)
        if m and m.group(1) in self.subs:
            sub = self.subs[m.group(1)]
            if method == "POST":
                sub["cancel_at_period_end"] = p.get("cancel_at_period_end") == "true"
            elif method == "DELETE":
                sub["status"] = "canceled"
            return 200, sub
        if method == "GET" and path == "/v1/invoices":
            inv = [i for i in self.invoices.values() if i["customer"] == p.get("customer") and i["status"] == p.get("status", "paid")]
            return 200, {"object": "list", "data": sorted(inv, key=lambda i: -i["created"])}
        if method == "POST" and path == "/v1/refunds":
            pi = p.get("payment_intent")
            if not any(i["payment_intent"] == pi for i in self.invoices.values()):
                return 400, {"error": {"code": "resource_missing", "message": f"No such payment_intent: {pi}"}}
            if any(r["payment_intent"] == pi for r in self.refunds):
                return 400, {"error": {"code": "charge_already_refunded", "message": "Charge has already been refunded."}}
            r = {"id": self.new_id("re"), "payment_intent": pi, "reason": p.get("reason"), "month": p.get("metadata[rig_month]"), "peer": p.get("metadata[rig_peer]")}
            self.refunds.append(r)
            return 200, {"id": r["id"], "status": "succeeded"}
        return 404, {"error": {"message": f"fake has no {method} {path}"}}

    def pay(self, customer, start, end, period_end=None, amount=499):
        """The customer's subscription (made on first use, active) and a paid invoice for [start, end)."""
        with self.lock:
            sub = next((s for s in self.subs.values() if s["customer"] == customer), None)
            if sub is None:
                sub = {"id": self.new_id("sub"), "customer": customer, "status": "active", "cancel_at_period_end": False,
                       "created": int(time.time()) - 60, "current_period_end": period_end or end}
                self.subs[sub["id"]] = sub
            inv = {"id": self.new_id("in"), "customer": customer, "status": "paid", "amount_paid": amount, "currency": "usd",
                   "payment_intent": self.new_id("pi"), "charge": self.new_id("ch"), "created": start,
                   "lines": {"object": "list", "data": [{"period": {"start": start, "end": end}}]}}
            self.invoices[inv["id"]] = inv
            return sub, inv


STRIPE = FakeStripe()


class BillingTest(RelayCase):
    EXTRA_ENV = {"STRIPE_SECRET_KEY": FakeStripe.SECRET, "STRIPE_PRICE_ID": "price_fake", "STRIPE_API_BASE": f"http://127.0.0.1:{STRIPE.port}",
                 "BILLING_SYNC_SECONDS": "0", "BILLING_GRACE_DAYS": "400", "SIGNUP_PER_IP_PER_DAY": "1000",
                 "BILLING_RETURN_URL": "https://example.com/rig?from=app"}

    def subscribe(self):
        """A signup device with a Stripe customer from Checkout. Returns (enroll answer, customer id)."""
        body = self.signup()
        status, r = self.call("POST", "/v1/billing/checkout", {}, token=body["token"])
        self.assertEqual(status, 200, r)
        return body, self.acct(body["name"])["customer"]

    def billing(self, token):
        status, st = self.call("GET", "/v1/billing", token=token)
        self.assertEqual(status, 200, st)
        return st

    def test_invited_device_is_never_billed(self):
        _, body = self.enroll("comp-1")
        st = self.billing(body["token"])
        self.assertEqual((st["enabled"], st["state"], st["entitled"], st["can_subscribe"]), (True, "comp", True, False))
        self.assertEqual(self.call("POST", "/v1/billing/checkout", {}, token=body["token"])[0], 409)
        self.assertEqual(self.call("POST", "/v1/billing/cancel", {}, token=body["token"])[0], 409)

    def test_trial_needs_no_card(self):
        body = self.signup()
        st = self.billing(body["token"])
        self.assertEqual((st["state"], st["entitled"], st["can_subscribe"], st["can_cancel"], st["can_manage"]), ("trial", True, True, False, False))
        self.assertEqual(st["price"], {"amount": 499, "currency": "usd", "interval": "month"})
        self.assertIsNone(self.acct(body["name"])["customer"], "a trial makes no Stripe customer")
        self.assertEqual(self.call("POST", "/v1/billing/portal", {}, token=body["token"])[0], 409)
        self.assertNotIn(FakeStripe.SECRET, json.dumps(st))

    def test_checkout_bills_from_the_first_of_the_month(self):
        body = self.signup()
        status, r = self.call("POST", "/v1/billing/checkout", {}, token=body["token"])
        self.assertEqual(status, 200, r)
        s = STRIPE.sessions[-1]
        self.assertEqual(r["url"], f"https://checkout.stripe.com/c/pay/{s['id']}")
        cus = self.acct(body["name"])["customer"]
        self.assertEqual(STRIPE.customers[cus]["metadata"]["rig_peer"], body["name"])
        self.assertEqual((s["mode"], s["customer"], s["client_reference_id"]), ("subscription", cus, body["name"]))
        self.assertEqual((s["line_items[0][price]"], s["line_items[0][quantity]"]), ("price_fake", "1"))
        self.assertEqual(int(s["subscription_data[billing_cycle_anchor]"]), month_starts()[3])
        self.assertEqual(s["subscription_data[proration_behavior]"], "create_prorations")
        self.assertEqual(s["success_url"], "https://example.com/rig?from=app&checkout=done")
        # A second checkout reuses the customer.
        self.assertEqual(self.call("POST", "/v1/billing/checkout", {}, token=body["token"])[0], 200)
        self.assertEqual(STRIPE.sessions[-1]["customer"], cus)
        self.assertEqual(sum(1 for c in STRIPE.customers.values() if c["metadata"]["rig_peer"] == body["name"]), 1)

    def test_months_without_a_gain_are_refunded_once(self):
        body, cus = self.subscribe()
        m2, m1, m0, nxt = month_starts()
        _, inv2 = STRIPE.pay(cus, m2 + 86400 * 9, m1, period_end=nxt)  # prorated first month
        _, inv1 = STRIPE.pay(cus, m1, m0)
        _, inv0 = STRIPE.pay(cus, m0, nxt)
        st = self.billing(body["token"])
        self.assertEqual((st["state"], st["entitled"], st["period_end"], st["can_cancel"]), ("active", True, nxt, True))
        self.assertEqual([i["id"] for i in st["invoices"]], [inv0["id"], inv1["id"], inv2["id"]])
        self.assertEqual({i["decision"] for i in st["invoices"]}, {"pending"})
        # This month is asked for only in its last 14 h, once it may be over in UTC+14.
        self.assertEqual(st["verdicts_needed"], [key(m2), key(m1)] + ([key(m0)] if time.time() >= nxt - 14 * 3600 else []))
        verdicts = [{"month": key(m1), "gained": True, "text": "Gain shown. No refund due."},
                    {"month": key(m2), "gained": False, "text": "No gain shown, refund due."}]
        status, st = self.call("POST", "/v1/billing/verdicts", {"verdicts": verdicts}, token=body["token"])
        self.assertEqual(status, 200, st)
        got = {i["id"]: (i["decision"], i["why"]) for i in st["invoices"]}
        self.assertEqual(got[inv2["id"]], ("refunded", "No gain shown, refund due."))
        self.assertEqual(got[inv1["id"]], ("kept", "Gain shown. No refund due."))
        self.assertEqual(got[inv0["id"]][0], "pending")
        mine = [r for r in STRIPE.refunds if r["peer"] == body["name"]]
        self.assertEqual(len(mine), 1)
        self.assertEqual((mine[0]["payment_intent"], mine[0]["month"], mine[0]["key"]), (inv2["payment_intent"], key(m2), f"rig-refund-{inv2['id']}"))
        # This month is not over: its verdict is ignored and not asked for.
        st = self.call("POST", "/v1/billing/verdicts", {"verdicts": [{"month": key(m0), "gained": False, "text": "x"}]}, token=body["token"])[1]
        self.assertEqual(({i["id"]: i["decision"] for i in st["invoices"]}[inv0["id"]], st["verdicts_needed"]), ("pending", []))
        # Decisions are final, and sweeps never refund twice.
        self.call("POST", "/v1/billing/verdicts", {"verdicts": [{"month": key(m2), "gained": True, "text": "late"}]}, token=body["token"])
        self.sweep()
        self.sweep()
        st = self.billing(body["token"])
        self.assertEqual({i["id"]: i["decision"] for i in st["invoices"]}[inv2["id"]], "refunded")
        self.assertEqual(len([r for r in STRIPE.refunds if r["peer"] == body["name"]]), 1)

    def test_no_verdict_means_a_refund_after_the_grace_days(self):
        body, cus = self.subscribe()
        m2, m1, _, _ = month_starts()
        _, inv = STRIPE.pay(cus, m2, m1)
        self.assertIn("refunded", self.sweep(BILLING_GRACE_DAYS="3"))
        a = self.acct(body["name"])["invoices"][inv["id"]]
        self.assertEqual(a["decision"], "refunded")
        self.assertIn("No verdict from the app within 3 days", a["why"])

    def test_cancel_is_one_click_and_keeps_the_paid_month(self):
        body, cus = self.subscribe()
        _, _, m0, nxt = month_starts()
        sub, _ = STRIPE.pay(cus, m0, nxt)
        status, st = self.call("POST", "/v1/billing/cancel", {}, token=body["token"])
        self.assertEqual(status, 200, st)
        self.assertTrue(STRIPE.subs[sub["id"]]["cancel_at_period_end"])
        self.assertEqual((st["state"], st["entitled"], st["period_end"], st["can_cancel"], st["can_manage"]), ("canceling", True, nxt, False, True))
        self.assertEqual(self.call("POST", "/v1/billing/cancel", {}, token=body["token"])[0], 409)
        status, r = self.call("POST", "/v1/billing/portal", {}, token=body["token"])
        self.assertEqual((status, r["url"].startswith("https://billing.stripe.com/")), (200, True))
        self.assertEqual(STRIPE.portals[-1], {"customer": cus, "return_url": "https://example.com/rig?from=app"})

    def test_trial_end_suspends_and_subscribing_resumes(self):
        body = self.signup()
        name = body["name"]
        self.edit_acct(name, trial_ends=int(time.time()) - 60)
        self.assertIn(f"{name}: suspended (lapsed)", self.sweep())
        self.assertTrue(self.suspended(name))
        st = self.billing(body["token"])
        self.assertEqual((st["state"], st["entitled"], st["can_subscribe"]), ("lapsed", False, True))
        # The token still works while suspended, so the player can subscribe.
        self.assertEqual(self.call("POST", "/v1/billing/checkout", {}, token=body["token"])[0], 200)
        _, _, m0, nxt = month_starts()
        STRIPE.pay(self.acct(name)["customer"], m0, nxt)
        st = self.billing(body["token"])
        self.assertEqual((st["state"], st["entitled"]), ("active", True))
        self.assertFalse(self.suspended(name))

    def test_leaving_ends_the_subscription(self):
        body, cus = self.subscribe()
        _, _, m0, nxt = month_starts()
        sub, _ = STRIPE.pay(cus, m0, nxt)
        self.billing(body["token"])
        self.assertEqual(self.call("DELETE", "/v1/peer", token=body["token"])[0], 204)
        self.assertEqual(STRIPE.subs[sub["id"]]["status"], "canceled")
        a = self.acct(body["name"])
        self.assertIsNotNone(a["closed"])
        # The paid month is still open, so the account stays until it is judged.
        self.sweep()
        self.assertTrue(os.path.exists(self.acct_file(body["name"])))

    def test_admin_remove_closes_the_account(self):
        body, cus = self.subscribe()
        m2, m1, _, _ = month_starts()
        sub, _ = STRIPE.pay(cus, m2, m1)
        subprocess.run([self.env["RIG_RELAY_ADD_PEER"], "--remove", body["name"]], env=self.env, check=True)
        self.sweep(BILLING_GRACE_DAYS="3")
        self.assertEqual(STRIPE.subs[sub["id"]]["status"], "canceled")
        self.assertFalse(os.path.exists(self.acct_file(body["name"])), "closed and settled: archived")
        closed = os.listdir(os.path.join(self.conf, "billing", "closed"))
        self.assertTrue(any(f.startswith(body["name"] + "-") for f in closed))

    def test_bad_verdicts_are_refused(self):
        body = self.signup()
        good = {"month": "2026-01", "gained": True, "text": "t"}
        for bad in ("x", [], [good] * 7, [{}], [dict(good, month="2026-13")], [dict(good, month="26-01")],
                    [dict(good, gained="yes")], [{"month": "2026-01", "gained": True}]):
            self.assertEqual(self.call("POST", "/v1/billing/verdicts", {"verdicts": bad}, token=body["token"])[0], 400, bad)

    def test_stripe_outage_keeps_the_last_state(self):
        body, cus = self.subscribe()
        _, _, m0, nxt = month_starts()
        STRIPE.pay(cus, m0, nxt)
        self.assertEqual(self.billing(body["token"])["state"], "active")
        STRIPE.fail = True
        try:
            self.assertEqual(self.billing(body["token"])["state"], "active")
            status, r = self.call("POST", "/v1/billing/cancel", {}, token=body["token"])
            self.assertEqual(status, 502, r)
            self.assertIn("billing provider error", r["error"])
            self.assertFalse(self.suspended(body["name"]))
        finally:
            STRIPE.fail = False


if __name__ == "__main__":
    unittest.main(verbosity=2)
