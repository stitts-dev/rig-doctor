// Billing section: this device's trial or subscription on a billed relay, this month's refund
// verdict (main.ts's card moves in here while the section shows), the last refund decisions, and
// Subscribe, Cancel and Manage billing. The backend (src-tauri/src/billing.rs) talks to the relay
// and sends each finished month's verdict; this file only shows what the relay answers.

import type { Backend } from "./backend";

export type BillingState = "comp" | "trial" | "active" | "canceling" | "past_due" | "lapsed";

export interface BillingPrice {
  /** Minor units (cents). */
  amount: number;
  currency: string;
  interval: string;
}

export interface BillingInvoice {
  id: string;
  /** The billed calendar month, "YYYY-MM". */
  month: string;
  /** Minor units (cents). */
  amount: number;
  currency: string;
  decision: "pending" | "kept" | "refunded";
  /** Why the relay kept or refunded it. */
  why: string | null;
}

/** GET /v1/billing on the relay, with the saved relay it is about. */
export interface BillingStatus {
  /** The saved relay's id. Actions go to this relay. */
  relay: string;
  /** False when the relay has no Stripe keys: nothing is billed. */
  enabled: boolean;
  /** "comp" is an invited device that is never billed. */
  state: BillingState;
  entitled: boolean;
  /** Unix seconds. */
  trial_ends: number | null;
  /** Unix seconds: the renewal date (active, past_due) or the end date (canceling). */
  period_end: number | null;
  price: BillingPrice | null;
  /** Newest first, at most 12. */
  invoices: BillingInvoice[];
  /** Months the relay waits on a verdict for. The backend sends them once they are over here. */
  verdicts_needed: string[];
  can_subscribe: boolean;
  can_cancel: boolean;
  can_manage: boolean;
}

export interface BillingOptions {
  /** This month's verdict card: under the Billing label while the section shows, else at the end of `monthHome`. */
  monthCard?: HTMLElement | null;
  monthHome?: HTMLElement | null;
}

export interface BillingUi {
  /** Reads the relay's billing state again. A read already running is followed by one more, not run twice. */
  refresh: () => Promise<void>;
}

/** States the section shows. Comp devices, and states a newer relay may add, keep it hidden. */
const SHOWN: BillingState[] = ["trial", "active", "canceling", "past_due", "lapsed"];
const EVERY_MS = 10 * 60_000;
/** After Subscribe, until the payment shows up or this long passes. */
const POLL_MS = 5_000;
const POLL_FOR_MS = 10 * 60_000;
const LEDGER = 3;

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long" });
/** "Nov 15". */
const day = (unixS: number) => dayFmt.format(new Date(unixS * 1000));

/** "$4.99" from minor units, with the currency's own decimals. */
function money(amount: number, currency: string): string {
  const code = String(currency ?? "").toUpperCase();
  try {
    const f = new Intl.NumberFormat(undefined, { style: "currency", currency: code });
    return f.format(amount / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    // Not a currency Intl knows: cents, as most are.
    return `${(amount / 100).toFixed(2)} ${code}`.trim();
  }
}

/** "$4.99/mo". Empty while the relay can't say. */
function priceText(p: BillingPrice | null): string {
  if (!p) return "";
  const per = p.interval === "month" ? "mo" : p.interval === "year" ? "yr" : p.interval;
  return `${money(p.amount, p.currency)}/${per}`;
}

/** The label's right side. */
function stateText(s: BillingStatus, nowMs: number): string {
  switch (s.state) {
    case "trial": {
      if (s.trial_ends == null) return "Trial";
      const days = Math.floor((s.trial_ends * 1000 - nowMs) / 86_400_000);
      return days >= 1 ? `Trial · ${days} day${days === 1 ? "" : "s"} left` : "Trial · ends today";
    }
    case "active":
      return "Active";
    case "canceling":
      return s.period_end != null ? `Ends ${day(s.period_end)}` : "Ending";
    case "past_due":
      return "Payment failed";
    default:
      return "Off";
  }
}

/** One sentence: what the device has and what happens next. */
function lineText(s: BillingStatus): string {
  switch (s.state) {
    case "trial":
      return s.trial_ends != null ? `Free trial until ${day(s.trial_ends)}. No card needed.` : "Free trial. No card needed.";
    case "active": {
      const head = [priceText(s.price), s.period_end != null ? `renews ${day(s.period_end)}` : ""].filter(Boolean).join(", ");
      return `${head ? `${head[0].toUpperCase()}${head.slice(1)}. ` : ""}A month without a measured gain is refunded automatically.`;
    }
    case "canceling":
      return `Canceled. The relay stays on until ${s.period_end != null ? day(s.period_end) : "the end of this period"}. No more charges.`;
    case "past_due":
      return "The last payment failed. Update the card to keep the relay.";
    default:
      return `${s.invoices.length ? "Subscription ended" : "Trial ended"}. Subscribe to use the relay again.`;
  }
}

const DECIDED: Record<BillingInvoice["decision"], string> = { refunded: "refunded", kept: "kept", pending: "waiting for the month's verdict" };

/** "October: $4.99 refunded". */
function ledgerText(i: BillingInvoice): string {
  const [y, m] = i.month.split("-").map(Number);
  const name = y && m >= 1 && m <= 12 ? monthFmt.format(new Date(y, m - 1, 1)) : i.month;
  return `${name}: ${money(i.amount, i.currency)} ${DECIDED[i.decision] ?? DECIDED.pending}`;
}

/**
 * An error as the panel shows it. A network error names the relay's URL, and the relay's address
 * stays out of the panel, which gets screenshotted: the full text is on hover.
 */
const withoutAddress = (e: string) => e.replace(/\bhttps?:\/\/[^/\s)]+/g, "");

/** The answer as the section reads it, or null when there is nothing to show. */
function usable(s: BillingStatus | null | undefined): BillingStatus | null {
  if (!s || typeof s !== "object" || !s.enabled || !SHOWN.includes(s.state)) return null;
  return { ...s, invoices: Array.isArray(s.invoices) ? s.invoices : [] };
}

export function mountBilling(api: Backend, root: HTMLElement, opts: BillingOptions = {}): BillingUi {
  root.innerHTML = `
    <div class="label"><span data-b="name">Billing</span><span class="num" data-b="state"></span></div>
    <div class="billing-line" data-b="line" aria-live="polite"></div>
    <div class="relay-row billing-actions" data-b="actions">
      <button class="btn billing-subscribe" type="button" data-b="subscribe" title="Opens Stripe Checkout in your browser">Subscribe</button>
      <button class="btn" type="button" data-b="manage" title="Card, invoices and receipts, on Stripe in your browser">Manage billing</button>
      <button class="btn" type="button" data-b="cancel">Cancel</button>
    </div>
    <div class="foot" data-b="checkout" hidden>Checkout is open in your browser. This updates when the payment goes through.</div>
    <ul class="billing-ledger" data-b="ledger" aria-label="Refund decisions" hidden></ul>
    <div class="foot relay-err" data-b="err" hidden></div>`;
  const $ = <T extends HTMLElement>(k: string) => root.querySelector<T>(`[data-b="${k}"]`)!;
  const label = root.querySelector<HTMLElement>(".label")!;
  const nameEl = $("name");
  const stateEl = $("state");
  const line = $("line");
  const actions = $("actions");
  const subscribe = $<HTMLButtonElement>("subscribe");
  const manage = $<HTMLButtonElement>("manage");
  const cancel = $<HTMLButtonElement>("cancel");
  const checkout = $("checkout");
  const ledger = $<HTMLUListElement>("ledger");
  const err = $("err");

  let status: BillingStatus | null = null;
  let error = "";
  let busy = false;
  let poll: ReturnType<typeof setInterval> | undefined;

  /** This month's verdict reads under the Billing label while the section shows, else under the relay controls. */
  const placeCard = (inside: boolean) => {
    const card = opts.monthCard;
    if (!card) return;
    if (inside) {
      if (label.nextElementSibling !== card) label.after(card);
    } else if (opts.monthHome && card.parentElement !== opts.monthHome) opts.monthHome.append(card);
  };

  const render = () => {
    const s = status;
    root.hidden = !s;
    placeCard(!!s);
    if (!s) return;
    nameEl.title = `Billing for relay ${s.relay}`;
    stateEl.textContent = stateText(s, Date.now());
    stateEl.classList.toggle("billing-alert", s.state === "past_due");
    line.textContent = lineText(s);
    const price = priceText(s.price);
    subscribe.textContent = price ? `Subscribe · ${price}` : "Subscribe";
    subscribe.hidden = !s.can_subscribe;
    manage.hidden = !s.can_manage;
    cancel.hidden = !s.can_cancel;
    cancel.title = `Cancels at the end of this period${s.period_end != null ? `, ${day(s.period_end)}` : ""}. The relay stays on until then.`;
    actions.hidden = !s.can_subscribe && !s.can_manage && !s.can_cancel;
    for (const b of [subscribe, manage, cancel]) b.disabled = busy;
    checkout.hidden = !poll;
    ledger.replaceChildren(
      ...s.invoices.slice(0, LEDGER).map((i) => {
        const li = document.createElement("li");
        li.dataset.decision = i.decision;
        li.textContent = ledgerText(i);
        if (i.why) li.title = i.why;
        return li;
      }),
    );
    ledger.hidden = !ledger.childElementCount;
    err.textContent = withoutAddress(error);
    err.title = error;
    err.hidden = !error;
  };

  const stopPoll = () => {
    clearInterval(poll);
    poll = undefined;
  };

  /** Bumped by Cancel, whose answer is newer than any read that started before it. */
  let changes = 0;
  const read = async () => {
    const seen = changes;
    let s: BillingStatus | null;
    try {
      s = usable(await api.call<BillingStatus | null>("billing_status", { tzOffsetMin: new Date().getTimezoneOffset() }));
    } catch (e) {
      // The last state stays up with the error under it. A section never shown stays hidden.
      if (seen === changes) error = String(e);
      render();
      return;
    }
    if (seen !== changes) return;
    status = s;
    error = "";
    if (!s || s.state === "active") stopPoll();
    render();
  };

  let reading: Promise<void> | undefined;
  let again = false;
  const refresh = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      do {
        again = false;
        await read();
      } while (again);
    })().finally(() => (reading = undefined));
    return reading;
  };

  /** Checkout finishes in the browser, so the state is read every few seconds until it shows. */
  const startPoll = () => {
    stopPoll();
    const until = Date.now() + POLL_FOR_MS;
    poll = setInterval(() => {
      if (Date.now() < until) return void refresh();
      stopPoll();
      render();
    }, POLL_MS);
  };

  /** Runs one button's call against the relay the shown state is about. */
  const act = async (f: (relay: string) => Promise<void>) => {
    if (busy || !status) return;
    const relay = status.relay;
    busy = true;
    error = "";
    render();
    try {
      await f(relay);
    } catch (e) {
      error = String(e);
    }
    busy = false;
    render();
  };

  subscribe.addEventListener("click", () =>
    void act(async (name) => {
      await api.call<void>("billing_checkout", { name });
      startPoll();
    }),
  );
  manage.addEventListener("click", () => void act((name) => api.call<void>("billing_portal", { name })));
  // One click: it ends at the period's end, and the relay stays on until then.
  cancel.addEventListener("click", () =>
    void act(async (name) => {
      status = usable(await api.call<BillingStatus>("billing_cancel", { name }));
      changes++;
    }),
  );

  window.addEventListener("focus", () => void refresh());
  setInterval(() => void refresh(), EVERY_MS);
  void refresh();
  return { refresh };
}
