"""Billing for the relay control API: no-card trial, Stripe subscription, automatic refunds.

A device that joins with a signup code (rig-relay-invite --signup) gets an account: a free trial
of TRIAL_DAYS, then a STRIPE_PRICE_ID subscription bought through Stripe Checkout. Invoices are
anchored to the 1st of the month (UTC), so the first one is prorated and every later one covers
one calendar month. When a month ends the app sends that month's verdict (desktop proof.rs, the
rule the app shows the player). A month whose verdict shows no gain, or whose verdict does not
arrive within GRACE_DAYS of the month's end, is refunded through Stripe's refunds API, once.

Devices joined with an admin invite have no account: they are never billed or suspended. A
device whose trial or subscription has ended is suspended (its WireGuard peer leaves wg0, its
token keeps working so it can subscribe). Without STRIPE_SECRET_KEY and STRIPE_PRICE_ID billing
is off: nothing is charged and nobody is suspended.

No webhooks: the relay has no domain or CA-signed certificate for Stripe to call. It reads
Stripe when the app asks for its billing state and in a sweep every SWEEP_SECONDS.

Stdlib only. Requests pin STRIPE_VERSION so response shapes never change under this code.
"""
import calendar
import contextlib
import fcntl
import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

def _int_env(name, default):
    # A typo in billing.env must not take the whole relay API down.
    try:
        return max(0, int(os.environ.get(name, default)))
    except ValueError:
        sys.stderr.write(f"billing: {name} is not a whole number; using {default}\n")
        return default


CONF_DIR = os.environ.get("RIG_RELAY_CONF_DIR", "/etc/rig-relay")
STRIPE_KEY = os.environ.get("STRIPE_SECRET_KEY", "").strip()
PRICE_ID = os.environ.get("STRIPE_PRICE_ID", "").strip()
STRIPE_API = os.environ.get("STRIPE_API_BASE", "https://api.stripe.com").rstrip("/")
STRIPE_VERSION = "2024-06-20"
RETURN_URL = os.environ.get("BILLING_RETURN_URL", "https://github.com/stitts-dev/rig-doctor")
TRIAL_DAYS = _int_env("TRIAL_DAYS", 7)
GRACE_DAYS = _int_env("BILLING_GRACE_DAYS", 3)
SWEEP_SECONDS = _int_env("BILLING_SWEEP_SECONDS", 3600)
SYNC_SECONDS = _int_env("BILLING_SYNC_SECONDS", 60)
DAY = 86400
# A local month can end up to 14 h before the UTC month does (UTC+14). Earlier than that, a
# verdict can't be final anywhere.
EARLIEST_TZ = 14 * 3600
MAX_VERDICTS = 6
MAX_TEXT = 240
MONTH_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
ENTITLED = ("trial", "active", "canceling", "past_due")
# Which of a customer's subscriptions this device is on: the live one, else the newest.
SUB_RANK = {"active": 0, "trialing": 0, "past_due": 1, "unpaid": 2, "paused": 2, "incomplete": 3, "canceled": 4, "incomplete_expired": 5}

# Set by api.py: runs rig-relay-add-peer with these arguments.
add_peer = None
_price = {"at": 0, "value": None}
_ssl = ssl.create_default_context()


class BillingError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class StripeError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def enabled():
    return bool(STRIPE_KEY and PRICE_ID)


def log(msg):
    sys.stderr.write(f"billing: {msg}\n")


# ---------- time ----------

def month_of(ts):
    t = time.gmtime(ts)
    return f"{t.tm_year:04d}-{t.tm_mon:02d}"


def month_start(key):
    y, m = int(key[:4]), int(key[5:7])
    return calendar.timegm((y, m, 1, 0, 0, 0))


def next_month_start(ts):
    t = time.gmtime(ts)
    y, m = (t.tm_year + 1, 1) if t.tm_mon == 12 else (t.tm_year, t.tm_mon + 1)
    return calendar.timegm((y, m, 1, 0, 0, 0))


def month_end(key):
    return next_month_start(month_start(key))


# ---------- Stripe ----------

def form(params, prefix=""):
    """Stripe's form encoding: nested objects as a[b], lists as a[0][b]."""
    out = []
    for k, v in params.items():
        key = f"{prefix}[{k}]" if prefix else k
        if v is None:
            continue
        if isinstance(v, dict):
            out += form(v, key)
        elif isinstance(v, (list, tuple)):
            for i, item in enumerate(v):
                if isinstance(item, dict):
                    out += form(item, f"{key}[{i}]")
                else:
                    out.append((f"{key}[{i}]", scalar(item)))
        else:
            out.append((key, scalar(v)))
    return out


def scalar(v):
    if v is True:
        return "true"
    if v is False:
        return "false"
    return str(v)


def stripe(method, endpoint, params=None, idempotency_key=None):
    url = STRIPE_API + endpoint
    data = None
    if params and method == "GET":
        url += "?" + urllib.parse.urlencode(form(params))
    elif params is not None:
        data = urllib.parse.urlencode(form(params)).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {STRIPE_KEY}")
    req.add_header("Stripe-Version", STRIPE_VERSION)
    if data is not None:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    if idempotency_key:
        req.add_header("Idempotency-Key", idempotency_key)
    try:
        with urllib.request.urlopen(req, timeout=20, context=_ssl) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error") or {}
        except ValueError:
            err = {}
        raise StripeError(e.code, err.get("code"), err.get("message") or f"HTTP {e.code}") from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise StripeError(0, None, f"could not reach Stripe: {e}") from None


def price():
    """The plan's price as the app shows it, cached for an hour. None when Stripe can't say."""
    if time.time() - _price["at"] < 3600:
        return _price["value"]
    try:
        p = stripe("GET", f"/v1/prices/{urllib.parse.quote(PRICE_ID)}")
        value = {"amount": int(p["unit_amount"]), "currency": p["currency"], "interval": (p.get("recurring") or {}).get("interval", "month")}
    except (StripeError, KeyError, TypeError, ValueError) as e:
        log(f"price lookup failed: {e}")
        return _price["value"]
    _price.update(at=time.time(), value=value)
    return value


# ---------- accounts ----------

def path(*parts):
    return os.path.join(CONF_DIR, "billing", *parts)


def acct_path(name):
    return path("accounts", f"{name}.json")


def load(name):
    try:
        with open(acct_path(name), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def save(acct):
    p = acct_path(acct["name"])
    tmp = f"{p}.tmp{os.getpid()}.{threading.get_ident()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(acct, f, separators=(",", ":"))
    os.replace(tmp, p)


def ensure_dirs():
    for sub in ("", "accounts", "locks", "closed"):
        os.makedirs(path(sub) if sub else path(), mode=0o700, exist_ok=True)


@contextlib.contextmanager
def locked(name):
    """One writer per account across the API's threads and a sweep run from the CLI."""
    ensure_dirs()
    with open(path("locks", f"{name}.lock"), "w", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def create_trial(name, now):
    ensure_dirs()
    acct = {"v": 1, "name": name, "created": now, "trial_ends": now + TRIAL_DAYS * DAY, "customer": None, "subscription": None,
            "sub_status": None, "cancel_at_period_end": False, "period_end": None, "synced": 0, "suspended": False,
            "verdicts": {}, "invoices": {}, "closed": None}
    with locked(name):
        save(acct)
    return acct


def drop(name):
    """Removes an account whose peer never came to be."""
    with contextlib.suppress(FileNotFoundError):
        os.unlink(acct_path(name))


def state(acct, now):
    s = acct.get("sub_status")
    if s in ("active", "trialing"):
        return "canceling" if acct.get("cancel_at_period_end") else "active"
    if s == "past_due":
        return "past_due"
    if now < acct["trial_ends"]:
        return "trial"
    return "lapsed"


def entitled(acct, now):
    return not enabled() or state(acct, now) in ENTITLED


def apply_sub(acct, sub, now):
    acct["subscription"] = sub["id"]
    acct["sub_status"] = sub.get("status")
    acct["cancel_at_period_end"] = bool(sub.get("cancel_at_period_end"))
    acct["period_end"] = sub.get("current_period_end")
    # Subscribing ends the free trial: a subscription that was paid for and then ended does not
    # hand the rest of the trial back.
    if sub.get("status") not in ("incomplete", "incomplete_expired"):
        acct["trial_ends"] = min(acct["trial_ends"], int(sub.get("created") or now))


def sync(acct, now, force=False):
    """Reads this device's subscription and paid invoices from Stripe."""
    if not acct.get("customer") or (not force and now - acct.get("synced", 0) < SYNC_SECONDS):
        return
    subs = stripe("GET", "/v1/subscriptions", {"customer": acct["customer"], "status": "all", "limit": 10}).get("data") or []
    if subs:
        apply_sub(acct, min(subs, key=lambda s: (SUB_RANK.get(s.get("status"), 9), -int(s.get("created") or 0))), now)
    invoices = stripe("GET", "/v1/invoices", {"customer": acct["customer"], "status": "paid", "limit": 24}).get("data") or []
    for inv in invoices:
        paid = int(inv.get("amount_paid") or 0)
        if inv["id"] in acct["invoices"] or paid <= 0:
            continue
        periods = [line.get("period") or {} for line in (inv.get("lines") or {}).get("data") or []]
        starts = [int(p["start"]) for p in periods if p.get("start")]
        ends = [int(p["end"]) for p in periods if p.get("end")]
        start = min(starts) if starts else int(inv.get("period_start") or inv.get("created") or now)
        end = max(ends) if ends else next_month_start(start)
        acct["invoices"][inv["id"]] = {"month": month_of(start), "start": start, "end": end, "amount": paid, "currency": inv.get("currency"),
                                       "payment_intent": inv.get("payment_intent"), "charge": inv.get("charge"),
                                       "decision": "pending", "why": None, "refund": None, "decided": None}
    acct["synced"] = now


def refund(acct, iid, inv):
    params = {"reason": "requested_by_customer", "metadata": {"rig_peer": acct["name"], "rig_month": inv["month"], "rig_invoice": iid}}
    if inv.get("payment_intent"):
        params["payment_intent"] = inv["payment_intent"]
    elif inv.get("charge"):
        params["charge"] = inv["charge"]
    else:
        raise StripeError(0, None, f"invoice {iid} has no card payment to refund; refund it in the Stripe dashboard")
    try:
        # The same key every time, so a retry after a timeout never refunds twice.
        inv["refund"] = stripe("POST", "/v1/refunds", params, idempotency_key=f"rig-refund-{iid}").get("id")
    except StripeError as e:
        if e.code != "charge_already_refunded":
            raise
        inv["refund"] = None


def decide(acct, now):
    """Settles every paid month that has ended: kept with a gain, refunded without one."""
    for iid, inv in sorted(acct["invoices"].items(), key=lambda kv: kv[1]["start"]):
        if inv["decision"] != "pending" or now < inv["end"]:
            continue
        v = acct["verdicts"].get(inv["month"])
        if v is not None and v["gained"]:
            inv.update(decision="kept", why=v["text"], decided=now)
            log(f"{acct['name']} {inv['month']}: gain shown, {iid} kept")
            continue
        if v is None and now < inv["end"] + GRACE_DAYS * DAY:
            continue
        why = v["text"] if v else f"No verdict from the app within {GRACE_DAYS} days of the month's end, so no gain shown. Refunded."
        try:
            refund(acct, iid, inv)
        except StripeError as e:
            log(f"{acct['name']} {inv['month']}: refund of {iid} failed, will retry: {e.message}")
            continue
        inv.update(decision="refunded", why=why, decided=now)
        log(f"{acct['name']} {inv['month']}: no gain shown, {iid} refunded")


def enforce(acct, now):
    """Keeps the WireGuard peer in step with the account: suspended exactly when not entitled."""
    if acct.get("closed"):
        return
    want = not entitled(acct, now)
    if want == bool(acct.get("suspended")):
        return
    try:
        add_peer("--suspend" if want else "--resume", acct["name"])
    except Exception as e:  # the next read or sweep tries again
        log(f"{acct['name']}: {'suspend' if want else 'resume'} failed: {e}")
        return
    acct["suspended"] = want
    log(f"{acct['name']}: {'suspended' if want else 'resumed'} ({state(acct, now)})")


def cancel_now(acct):
    """Ends the subscription today, for a device that left. Its paid months are still judged."""
    if acct.get("subscription") and acct.get("sub_status") not in ("canceled", "incomplete_expired"):
        sub = stripe("DELETE", f"/v1/subscriptions/{urllib.parse.quote(acct['subscription'])}")
        acct["sub_status"] = sub.get("status", "canceled")


def peer_exists(name):
    return os.path.exists(os.path.join(CONF_DIR, "peers", f"{name}.conf"))


def needed(acct, now):
    """Ended months with a paid invoice still waiting for the app's verdict."""
    months = {inv["month"] for inv in acct["invoices"].values() if inv["decision"] == "pending"}
    return sorted(m for m in months if m not in acct["verdicts"] and now >= month_end(m) - EARLIEST_TZ)[:MAX_VERDICTS]


COMP = {"state": "comp", "entitled": True, "trial_ends": None, "period_end": None, "price": None, "invoices": [], "verdicts_needed": [],
        "can_subscribe": False, "can_cancel": False, "can_manage": False}


def status(acct, now):
    on = enabled()
    if acct is None:
        return {"enabled": on, **COMP}
    st = state(acct, now)
    invoices = sorted(acct["invoices"].items(), key=lambda kv: (kv[1]["start"], kv[0]), reverse=True)[:12]
    return {
        "enabled": on,
        "state": st,
        "entitled": entitled(acct, now),
        "trial_ends": acct["trial_ends"],
        "period_end": acct.get("period_end") if st in ("active", "canceling", "past_due") else None,
        "price": price() if on else None,
        "invoices": [{"id": i, "month": v["month"], "amount": v["amount"], "currency": v["currency"], "decision": v["decision"], "why": v["why"]} for i, v in invoices],
        "verdicts_needed": needed(acct, now) if on else [],
        "can_subscribe": on and st in ("trial", "lapsed"),
        "can_cancel": on and st in ("active", "past_due"),
        "can_manage": on and bool(acct.get("customer")),
    }


def refresh(acct, now, force=False):
    """Stripe's view, then refunds, then the tunnel. A Stripe outage keeps the last known state."""
    if not enabled():
        return
    try:
        sync(acct, now, force)
    except StripeError as e:
        log(f"{acct['name']}: Stripe read failed, using the last known state: {e.message}")
    decide(acct, now)
    enforce(acct, now)


# ---------- API calls (api.py routes them; `name` is the token's owner) ----------

def require(acct):
    if not enabled():
        raise BillingError(503, "billing is not set up on this relay")
    if acct is None:
        raise BillingError(409, "this device joined with an invite and is never billed")


def read_status(name):
    now = int(time.time())
    with locked(name):
        acct = load(name)
        if acct is None:
            return status(None, now)
        refresh(acct, now)
        save(acct)
        return status(acct, now)


def checkout(name):
    now = int(time.time())
    with locked(name):
        acct = load(name)
        require(acct)
        refresh(acct, now, force=True)
        save(acct)
        if state(acct, now) in ("active", "canceling", "past_due"):
            raise BillingError(409, "this device already has a subscription; use Manage billing")
        anchor = next_month_start(now)
        if anchor - now < 120:
            raise BillingError(503, "a new month starts in under two minutes; try again after it does")
        if not acct.get("customer"):
            c = stripe("POST", "/v1/customers", {"description": f"Rig Doctor relay device {name}", "metadata": {"rig_peer": name}},
                       idempotency_key=f"rig-customer-{name}-{acct['created']}")
            acct["customer"] = c["id"]
            save(acct)
        s = stripe("POST", "/v1/checkout/sessions", {
            "mode": "subscription",
            "customer": acct["customer"],
            "client_reference_id": name,
            "line_items": [{"price": PRICE_ID, "quantity": 1}],
            # Invoices start on the 1st, so each one covers the calendar month the app judges.
            "subscription_data": {"billing_cycle_anchor": anchor, "proration_behavior": "create_prorations", "metadata": {"rig_peer": name}},
            "success_url": back("checkout=done"),
            "cancel_url": back("checkout=canceled"),
        })
        # The next status read goes to Stripe, so a finished checkout shows up at once.
        acct["synced"] = 0
        save(acct)
        return {"url": s["url"]}


def back(query):
    """The return page with ?checkout=..., kept ahead of any #fragment."""
    u = urllib.parse.urlsplit(RETURN_URL)
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, f"{u.query}&{query}" if u.query else query, u.fragment))


def portal(name):
    with locked(name):
        acct = load(name)
        require(acct)
        if not acct.get("customer"):
            raise BillingError(409, "no billing account yet; subscribe first")
        s = stripe("POST", "/v1/billing_portal/sessions", {"customer": acct["customer"], "return_url": RETURN_URL})
        acct["synced"] = 0
        save(acct)
        return {"url": s["url"]}


def cancel(name):
    """One click: the subscription ends at the end of the paid month, which is still judged."""
    now = int(time.time())
    with locked(name):
        acct = load(name)
        require(acct)
        sync(acct, now, force=True)
        if state(acct, now) not in ("active", "past_due"):
            save(acct)
            raise BillingError(409, "no active subscription to cancel")
        sub = stripe("POST", f"/v1/subscriptions/{urllib.parse.quote(acct['subscription'])}", {"cancel_at_period_end": True})
        apply_sub(acct, sub, now)
        decide(acct, now)
        enforce(acct, now)
        save(acct)
        log(f"{name}: canceled at period end")
        return status(acct, now)


def report(name, items):
    """Takes the app's month verdicts. Only months already over somewhere on Earth count."""
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_VERDICTS:
        raise BillingError(400, f"verdicts must be a list of 1-{MAX_VERDICTS}")
    clean = []
    for v in items:
        if not isinstance(v, dict) or not isinstance(v.get("month"), str) or not MONTH_RE.match(v["month"]):
            raise BillingError(400, "each verdict needs a month as YYYY-MM")
        if not isinstance(v.get("gained"), bool) or not isinstance(v.get("text"), str):
            raise BillingError(400, "each verdict needs gained (true/false) and text")
        clean.append((v["month"], v["gained"], v["text"][:MAX_TEXT]))
    now = int(time.time())
    with locked(name):
        acct = load(name)
        require(acct)
        for month, gained, text in clean:
            decided = any(i["month"] == month and i["decision"] != "pending" for i in acct["invoices"].values())
            if decided or now < month_end(month) - EARLIEST_TZ:
                continue
            acct["verdicts"][month] = {"gained": gained, "text": text, "at": now}
        acct["verdicts"] = dict(sorted(acct["verdicts"].items())[-24:])
        refresh(acct, now)
        save(acct)
        return status(acct, now)


def leave(name):
    """The device removes itself: its subscription ends now, and the account stays for refunds."""
    if load(name) is None:
        return
    now = int(time.time())
    with locked(name):
        acct = load(name)
        if acct is None:
            return
        acct["closed"] = now
        if enabled():
            try:
                cancel_now(acct)
            except StripeError as e:
                log(f"{name}: cancel on leave failed, the sweep retries: {e.message}")
        save(acct)


# ---------- sweep ----------

def sweep_one(name, now):
    with locked(name):
        acct = load(name)
        if acct is None:
            return
        if not enabled():
            # Billing switched off: nobody stays cut off.
            if acct.get("suspended") and not acct.get("closed"):
                add_peer("--resume", name)
                acct["suspended"] = False
                save(acct)
                log(f"{name}: resumed (billing is off)")
            return
        if not acct.get("closed") and not peer_exists(name):
            acct["closed"] = now
        refresh(acct, now, force=True)
        if acct.get("closed"):
            try:
                cancel_now(acct)
            except StripeError as e:
                log(f"{name}: cancel after leaving failed, will retry: {e.message}")
            if peer_exists(name):
                # A leave that stopped between closing the account and removing the peer.
                try:
                    add_peer("--remove", name)
                except Exception as e:
                    log(f"{name}: removing the peer after leaving failed, will retry: {e}")
        save(acct)
        settled = all(i["decision"] != "pending" for i in acct["invoices"].values())
        if acct.get("closed") and settled and acct.get("sub_status") in (None, "canceled", "incomplete_expired"):
            os.replace(acct_path(name), path("closed", f"{name}-{now}.json"))
            log(f"{name}: closed and settled, archived")


def sweep(now=None):
    """Every account once: Stripe state, month decisions, the tunnel. Returns the count."""
    now = int(now or time.time())
    ensure_dirs()
    names = sorted(f[:-5] for f in os.listdir(path("accounts")) if f.endswith(".json") and NAME_RE.match(f[:-5]))
    for name in names:
        try:
            sweep_one(name, now)
        except Exception as e:  # one bad account never stops the others
            log(f"{name}: sweep failed: {e!r}")
    return len(names)


def sweep_loop():
    time.sleep(60)
    while True:
        try:
            sweep()
        except Exception as e:
            log(f"sweep failed: {e!r}")
        time.sleep(SWEEP_SECONDS)
