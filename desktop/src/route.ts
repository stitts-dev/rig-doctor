// Reading a trace as a journey: who carries the packets, where, and which stretch costs the time.
// Pure functions over located hops, so they can be checked without the app.

import { estimateLegMs, haversineKm, isPrivateIp } from "./geo";
import type { Geo, Hop } from "./types";

/** Networks named from the router's reverse DNS domain, used when GeoIP has no ASN for a hop. */
const DOMAIN_NET: [RegExp, string][] = [
  [/\.comcast\.net$/, "Comcast"],
  [/\.riotdirect\.net$/, "Riot Direct"],
  [/\.gtt\.net$/, "GTT"],
  [/\.cogentco\.com$/, "Cogent"],
  [/\.zayo\.com$/, "Zayo"],
  [/\.(level3|lumen)\.(net|com)$/, "Lumen"],
  [/\.he\.net$/, "Hurricane Electric"],
  [/\.(telia|arelion)\.net$/, "Arelion"],
  [/\.ntt\.net$/, "NTT"],
  [/\.(alter\.net|verizon\.com|myvzw\.com)$/, "Verizon"],
  [/\.(att\.net|sbcglobal\.net)$/, "AT&T"],
  [/\.(rr\.com|charter\.com|spectrum\.com)$/, "Spectrum"],
  [/\.cox\.net$/, "Cox"],
  [/\.(1e100\.net|google\.com)$/, "Google"],
  [/\.cloudflare\.(com|net)$/, "Cloudflare"],
  [/\.amazonaws\.com$/, "Amazon"],
  [/\.akamai(technologies)?\.(com|net)$/, "Akamai"],
  [/\.tailscale\.com$/, "Tailscale"],
  [/\.ovh\.(net|ca|com)$/, "OVH"],
];

export interface Net {
  /** Identity for grouping: the ASN when known, else the name. */
  id: string;
  name: string;
  asn?: string;
}

/** Shorten a GeoIP owner: "AS7922 Comcast Cable Communications, LLC" → "Comcast Cable Communications". */
function cleanOwner(s: string): string {
  return s
    .replace(/^AS\d+\s+/i, "")
    .replace(/,?\s+(Inc|LLC|Ltd|L\.L\.C|Corp|Corporation|S\.A\.S|SAS|GmbH|B\.V)\.?$/i, "")
    .trim();
}

export function networkOf(h: Hop, geo: Geo | undefined): Net | undefined {
  if (!h.ip) return undefined;
  if (isPrivateIp(h.ip)) return { id: "private", name: "Private address" };
  const asn = geo?.as?.match(/^AS\d+/i)?.[0].toUpperCase();
  const fromDns = h.rdns ? DOMAIN_NET.find(([re]) => re.test(h.rdns!.toLowerCase()))?.[1] : undefined;
  const owner = geo?.as ? cleanOwner(geo.as) : geo?.isp ? cleanOwner(geo.isp) : undefined;
  const name = fromDns ?? owner;
  if (!name && !asn) return undefined;
  return { id: asn ?? name!, name: name ?? asn!, asn };
}

/**
 * Lowest believable RTT to each hop. Routers answer traceroute from a slow path and often
 * report more than packets passing through them actually take, but a later hop's reply
 * travelled through every earlier one, so the time to a hop is at most the best time to any hop after it.
 */
export function floorRtts(hops: Hop[]): Map<number, number> {
  const out = new Map<number, number>();
  let floor = Infinity;
  for (let i = hops.length - 1; i >= 0; i--) {
    const good = hops[i].rtts.filter((v): v is number => v != null);
    if (good.length) floor = Math.min(floor, ...good);
    if (good.length && Number.isFinite(floor)) out.set(hops[i].hop, floor);
  }
  return out;
}

export interface Segment {
  net: Net;
  /** Hop numbers of the first and last hop that answered inside this network. */
  first: number;
  last: number;
  hops: Hop[];
  from?: string;
  to?: string;
  /** Floor RTT where the packets leave this network. */
  exitMs?: number;
  /** Time this stretch adds: its exit minus the previous segment's exit. */
  addedMs?: number;
  /** Distance covered inside it, entry to exit, plus the hop from the previous segment. */
  km?: number;
  /** Added time well beyond what the distance explains. */
  slow?: boolean;
}

const placeName = (h: Hop): string | undefined => (h.lat != null && h.source !== "home" ? h.place : undefined);

/**
 * Group the hops by the network that carries them. The first private hop is the home router.
 * Later private hops belong to the ISP behind it and join the next public network. Silent hops
 * never split a network.
 */
export function segments(hops: Hop[], geo: Map<string, Geo>, home?: { lat: number; lng: number; label: string }): Segment[] {
  const sorted = [...hops].sort((a, b) => a.hop - b.hop);
  const floors = floorRtts(sorted);
  const out: Segment[] = [];
  let pendingPrivate: Hop[] = [];
  for (const h of sorted) {
    if (!h.ip || h.avg == null) continue;
    // Unknown routers in a row are counted as one unnamed network.
    const net = networkOf(h, geo.get(h.ip)) ?? { id: "?", name: "Unknown network" };
    if (net.id === "private") {
      if (!out.length && !pendingPrivate.length) {
        out.push({ net: { id: "home", name: "Your network" }, first: h.hop, last: h.hop, hops: [h], from: home?.label, to: home?.label });
      } else pendingPrivate.push(h);
      continue;
    }
    const cur = out[out.length - 1];
    if (cur && cur.net.id === net.id) {
      cur.hops.push(...pendingPrivate, h);
      cur.last = h.hop;
    } else {
      out.push({ net, first: pendingPrivate[0]?.hop ?? h.hop, last: h.hop, hops: [...pendingPrivate, h] });
    }
    pendingPrivate = [];
  }
  // Private hops at the very end (rare) stay with the last network.
  if (pendingPrivate.length && out.length) out[out.length - 1].hops.push(...pendingPrivate);

  let prevExit = 0;
  let prevPt: { lat: number; lng: number } | undefined = home;
  for (const s of out) {
    const located = s.hops.filter((h) => placeName(h));
    s.from ??= located[0]?.place;
    s.to ??= located[located.length - 1]?.place;
    const exit = [...s.hops].reverse().map((h) => floors.get(h.hop)).find((v) => v != null);
    s.exitMs = exit;
    if (exit != null) {
      s.addedMs = Math.max(0, exit - prevExit);
      prevExit = Math.max(prevExit, exit);
    }
    let km = 0;
    for (const h of located) {
      if (prevPt) km += haversineKm(prevPt.lat, prevPt.lng, h.lat!, h.lng!);
      prevPt = { lat: h.lat!, lng: h.lng! };
    }
    s.km = located.length ? km : undefined;
    s.slow = s.addedMs != null && s.addedMs > 2 * estimateLegMs(s.km ?? 0) + 10;
  }
  return out;
}

export interface Jump {
  from: Hop;
  to: Hop;
  ms: number;
}

/** The single step between two answering hops that adds the most time, by floor RTT. */
export function biggestJump(hops: Hop[]): Jump | undefined {
  const sorted = [...hops].sort((a, b) => a.hop - b.hop);
  const floors = floorRtts(sorted);
  let prev: Hop | undefined;
  let best: Jump | undefined;
  for (const h of sorted) {
    const f = floors.get(h.hop);
    if (f == null) continue;
    const pf = prev ? floors.get(prev.hop)! : 0;
    if (prev && (!best || f - pf > best.ms)) best = { from: prev, to: h, ms: f - pf };
    prev = h;
  }
  return best && best.ms >= 5 ? best : undefined;
}

/** Town alone, so rDNS and GeoIP spellings match: "Chicago, IL (350 E Cermak)" and "Chicago, Illinois" → "Chicago". */
export const town = (place: string): string => place.replace(/\s*\(.*\)$/, "").split(",")[0].trim();

/**
 * What identifies a path: the networks in order and the cities each one passes through.
 * Two runs that differ only by a router that did not answer this time have the same key.
 */
export function pathKey(segs: Segment[]): string[] {
  const out: string[] = [];
  for (const s of segs) {
    if (s.net.id === "home") continue;
    out.push(`#${s.net.id}`);
    for (const h of s.hops) {
      const p = placeName(h);
      if (p && out[out.length - 1] !== town(p)) out.push(town(p));
    }
  }
  return out;
}

/** Whether `a` is `b` with some cities missing (same networks, cities a subsequence). */
export function samePath(a: string[], b: string[]): boolean {
  const nets = (k: string[]) => k.filter((x) => x.startsWith("#")).join(">");
  if (nets(a) !== nets(b)) return false;
  const sub = (x: string[], y: string[]) => {
    let i = 0;
    for (const v of y) if (v === x[i]) i++;
    return i === x.length;
  };
  return sub(a, b) || sub(b, a);
}

/** "Comcast → Riot Direct" */
export const netChain = (segs: Segment[]): string =>
  segs
    .filter((s) => s.net.id !== "home")
    .map((s) => s.net.name)
    .join(" → ");

/** Cities a path passes through, for telling two paths of the same networks apart. */
export const viaCities = (key: string[]): string[] => key.filter((x) => !x.startsWith("#"));
