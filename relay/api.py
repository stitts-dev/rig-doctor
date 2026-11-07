#!/usr/bin/env python3
"""Rig Doctor relay control API: per-player peers without SSH.

Runs as rig-relay-api.service (setup.sh installs it). HTTPS with the relay's
self-signed certificate, which invites pin, so no domain or CA is needed.

  POST   /v1/enroll  {"invite": SECRET, "public_key": KEY}  -> config + device token
  GET    /v1/config  (Bearer token)  -> current config, prefix version, game ranges
  POST   /v1/servers (Bearer token) {"prefixes": ["a.b.c.0/24", ...]}  -> game ranges
  GET    /v1/health  (Bearer token)  -> tunnel health and this player's peer stats
  DELETE /v1/peer    (Bearer token)  -> removes this player's peer and token

Configs never carry a private key: the client generates its own and fills in
the PrivateKey line. Peer changes go through rig-relay-add-peer, so the API and
the admin CLI share one code path and one lock. Only hashes of invite secrets
and device tokens are stored.

Game ranges (game4.txt) are the /24s of game servers players saw in their
matches. Apps narrow their tunnel to them; riot4.txt stays the outer bound, so
only /24s inside it are kept and the firewall is unchanged.
"""
import fcntl
import ipaddress
import hashlib
import hmac
import json
import os
import re
import secrets
import ssl
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF_DIR = os.environ.get("RIG_RELAY_CONF_DIR", "/etc/rig-relay")
LIB_DIR = os.environ.get("RIG_RELAY_LIB_DIR", "/usr/local/lib/rig-relay")
ADD_PEER = os.environ.get("RIG_RELAY_ADD_PEER", os.path.join(LIB_DIR, "add-peer.sh"))
WG_IF = "wg0"
MAX_BODY = 4096
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
KEY_RE = re.compile(r"^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$")
SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
PLACEHOLDER = "<client private key>"
MAX_REPORT = 16
MAX_GAME_RANGES = 1024


def sha256_hex(s):
    return hashlib.sha256(s.encode()).hexdigest()


def path(*parts):
    return os.path.join(CONF_DIR, *parts)


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def write_private(p, text):
    tmp = f"{p}.tmp{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, p)


def prefix_version():
    """Changes whenever the game prefix list does; clients refresh on a change."""
    with open(path("riot4.txt"), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:16]


def riot_nets():
    with open(path("riot4.txt"), encoding="utf-8") as f:
        return [ipaddress.ip_network(line.strip(), strict=False) for line in f if line.strip()]


def game_ranges():
    """Known game server /24s that are still inside the Riot list."""
    try:
        lines = read(path("game4.txt")).split()
    except FileNotFoundError:
        return []
    riot = riot_nets()
    out = []
    for line in lines:
        try:
            net = ipaddress.IPv4Network(line)
        except ValueError:
            continue
        if any(net.subnet_of(r) for r in riot if r.version == 4):
            out.append(str(net))
    return out


def valid_game_range(s, riot):
    """An IPv4 /24 with zero host bits inside a Riot prefix, or None."""
    if not isinstance(s, str) or len(s) > 18:
        return None
    try:
        net = ipaddress.IPv4Network(s)
    except ValueError:
        return None
    if net.prefixlen != 24:
        return None
    return net if any(net.subnet_of(r) for r in riot if r.version == 4) else None


def add_game_ranges(prefixes):
    if not isinstance(prefixes, list) or not 1 <= len(prefixes) <= MAX_REPORT:
        raise ApiError(400, f"prefixes must be a list of 1-{MAX_REPORT} /24s")
    riot = riot_nets()
    nets = [valid_game_range(p, riot) for p in prefixes]
    if any(n is None for n in nets):
        raise ApiError(400, "every prefix must be an IPv4 /24 inside the relay's game list")
    with open(path("game4.lock"), "w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            have = set(read(path("game4.txt")).split())
        except FileNotFoundError:
            have = set()
        new = {str(n) for n in nets} - have
        if new and len(have) + len(new) <= MAX_GAME_RANGES:
            text = "".join(f"{n}\n" for n in sorted(have | new, key=lambda x: ipaddress.IPv4Network(x)))
            tmp = path(f"game4.txt.tmp{os.getpid()}")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(text)
            os.chmod(tmp, 0o644)
            os.replace(tmp, path("game4.txt"))
        return len(new)


def add_peer(*args):
    r = subprocess.run([ADD_PEER, *args], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise ApiError(500, "peer change failed")
    return r.stdout


def peer_key(name):
    m = re.search(r"^PublicKey = (\S+)$", read(path("peers", f"{name}.conf")), re.M)
    return m.group(1) if m else None


def client_config(name):
    conf = add_peer("--show", name)
    if PLACEHOLDER not in conf:
        # The relay generated this peer's key (old SSH flow). Never serve it.
        raise ApiError(409, "this peer's key is held by the relay; re-enroll with an invite")
    return conf


def consume_invite(secret):
    """Atomically claims an invite: only one request can rename the file."""
    if not SECRET_RE.match(secret or ""):
        raise ApiError(403, "invalid invite")
    src = path("api", "invites", sha256_hex(secret) + ".json")
    claimed = f"{src}.claimed{os.getpid()}.{secrets.token_hex(4)}"
    try:
        os.rename(src, claimed)
    except FileNotFoundError:
        raise ApiError(403, "invalid or used invite") from None
    try:
        inv = json.loads(read(claimed))
    finally:
        os.unlink(claimed)
    if int(inv.get("expires", 0)) < time.time():
        raise ApiError(403, "invite expired")
    if not NAME_RE.match(inv.get("name", "")):
        raise ApiError(403, "invalid invite")
    return inv["name"]


def token_owner(header):
    """The peer name a Bearer token belongs to, or None."""
    if not header or not header.startswith("Bearer "):
        return None
    want = sha256_hex(header[7:].strip())
    clients = path("clients")
    for f in sorted(os.listdir(clients)):
        if not f.endswith(".token"):
            continue
        try:
            have = read(os.path.join(clients, f)).strip()
        except FileNotFoundError:
            continue
        if hmac.compare_digest(have, want):
            name = f[: -len(".token")]
            return name if NAME_RE.match(name) else None
    return None


def wg_peers():
    """{public_key: {latest_handshake, rx_bytes, tx_bytes}} from `wg show wg0 dump`."""
    r = subprocess.run(["wg", "show", WG_IF, "dump"], capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        return None
    peers = {}
    for line in r.stdout.splitlines()[1:]:
        f = line.split("\t")
        if len(f) >= 7:
            peers[f[0]] = {"latest_handshake": int(f[4]), "rx_bytes": int(f[5]), "tx_bytes": int(f[6])}
    return peers


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "rig-relay-api/1"
    sys_version = ""
    timeout = 10
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def send(self, status, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "bad Content-Length") from None
        if n <= 0 or n > MAX_BODY:
            raise ApiError(413 if n > MAX_BODY else 400, "body must be 1-4096 bytes")
        try:
            v = json.loads(self.rfile.read(n))
        except ValueError:
            raise ApiError(400, "body is not JSON") from None
        if not isinstance(v, dict):
            raise ApiError(400, "body must be a JSON object")
        return v

    def owner(self):
        name = token_owner(self.headers.get("Authorization"))
        if not name or not os.path.exists(path("peers", f"{name}.conf")):
            raise ApiError(401, "unknown or revoked token")
        return name

    def route(self, method):
        p = self.path.split("?", 1)[0]
        if method == "POST" and p == "/v1/enroll":
            return self.enroll()
        if method == "GET" and p == "/v1/config":
            name = self.owner()
            return 200, {"name": name, "config": client_config(name), "prefix_version": prefix_version(), "game_prefixes": game_ranges()}
        if method == "POST" and p == "/v1/servers":
            name = self.owner()
            added = add_game_ranges(self.body().get("prefixes"))
            if added:
                self.log_message("%s reported %d new game range(s)", name, added)
            return 200, {"game_prefixes": game_ranges()}
        if method == "GET" and p == "/v1/health":
            return self.health(self.owner())
        if method == "DELETE" and p == "/v1/peer":
            name = self.owner()
            add_peer("--remove", name)
            return 204, None
        raise ApiError(404, "not found")

    def enroll(self):
        b = self.body()
        key = b.get("public_key")
        if not isinstance(key, str) or not KEY_RE.match(key):
            raise ApiError(400, "public_key is not a WireGuard public key")
        secret = b.get("invite")
        name = consume_invite(secret if isinstance(secret, str) else "")
        if os.path.exists(path("peers", f"{name}.conf")):
            raise ApiError(409, f"a peer named {name} already exists")
        conf = add_peer(name, "--pubkey", key)
        token = secrets.token_urlsafe(32)
        write_private(path("clients", f"{name}.token"), sha256_hex(token) + "\n")
        self.log_message("enrolled %s", name)
        return 200, {"name": name, "config": conf, "prefix_version": prefix_version(), "token": token}

    def health(self, name):
        peers = wg_peers()
        key = peer_key(name)
        with open(path("riot4.txt"), encoding="utf-8") as f:
            prefixes = sum(1 for line in f if line.strip())
        return 200, {
            "ok": peers is not None,
            "wg_up": peers is not None,
            "peers": len(peers or {}),
            "prefix_version": prefix_version(),
            "prefixes": prefixes,
            "game_ranges": len(game_ranges()),
            "you": (peers or {}).get(key),
            "time": int(time.time()),
        }

    def handle_method(self, method):
        try:
            status, body = self.route(method)
        except ApiError as e:
            status, body = e.status, {"error": e.message}
        except Exception as e:  # never leak a traceback to the client
            self.log_message("error: %r", e)
            status, body = 500, {"error": "internal error"}
        self.send(status, body)

    def do_GET(self):
        self.handle_method("GET")

    def do_POST(self):
        self.handle_method("POST")

    def do_DELETE(self):
        self.handle_method("DELETE")


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Failed TLS handshakes and dropped clients: one line, no traceback.
        sys.stderr.write(f"{client_address[0]} connection error: {sys.exc_info()[1]!r}\n")


def main():
    port = int(os.environ.get("API_PORT", "51821"))
    bind = os.environ.get("API_BIND", "0.0.0.0")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(path("api", "tls.crt"), path("api", "tls.key"))
    srv = Server((bind, port), Handler)
    # Handshake in the request thread, so a slow client cannot stall accept().
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True, do_handshake_on_connect=False)
    sys.stderr.write(f"rig-relay-api listening on {bind}:{port}\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()
