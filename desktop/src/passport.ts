// The passport: every city and network a finished trace crossed and each place a route entered
// Riot Direct, kept by the backend so they stay on the globe, plus personal bests from the match
// log. No addresses, only names, rough coordinates and times.

import type { Net, Segment } from "./route";
import type { Hop } from "./types";

export interface CityStamp {
  place: string;
  lat: number;
  lng: number;
  /** When it was first and last crossed, ms since the epoch, and by how many traces. */
  first: number;
  last: number;
  n: number;
}

export interface NetStamp {
  id: string;
  name: string;
  first: number;
  last: number;
  n: number;
}

/** A place a route entered Riot's network, and the network that handed the traffic over. */
export interface RiotEntry {
  place: string;
  lat: number;
  lng: number;
  from: string | null;
  first: number;
  last: number;
  n: number;
}

/** A personal best: the path, the number (ms), and the match that set it. */
export interface BestMatch {
  path: string;
  ms: number;
  id: string;
}

export interface Bests {
  /** Each path's lowest in-game median, best first. */
  by_path: BestMatch[];
  /** The lowest jitter of any match, `ms` being the jitter. */
  steadiest: BestMatch | null;
  /** The longest run of matches in a row with no packet lost. */
  clean_run: number;
}

/** passport_read */
export interface Passport {
  cities: CityStamp[];
  networks: NetStamp[];
  riot: RiotEntry[];
  bests: Bests;
}

/** passport_add: what one finished trace crossed. */
export interface Stamps {
  cities: { place: string; lat: number; lng: number }[];
  networks: { id: string; name: string }[];
  riot: { place: string; lat: number; lng: number; from: string | null }[];
}

/** A hop whose place the map believes: located, not this machine, and not moved or doubted by the checks against its RTT. */
const trusted = (h: Hop): h is Hop & { lat: number; lng: number; place: string } => h.lat != null && h.lng != null && !!h.place && h.source !== "home" && !h.implausible && !h.estimated;

const isRiot = (n: Net): boolean => n.id === "AS6507" || n.name === "Riot Direct";

/** What a finished trace stamps: each trusted city, each named network, and where it entered Riot's network. */
export function stampsOf(segs: Segment[]): Stamps {
  const cities = new Map<string, Stamps["cities"][number]>();
  const networks = new Map<string, Stamps["networks"][number]>();
  const riot = new Map<string, Stamps["riot"][number]>();
  segs.forEach((s, i) => {
    if (s.net.id !== "home" && s.net.id !== "private" && s.net.id !== "?") networks.set(s.net.id, { id: s.net.id, name: s.net.name });
    const here = s.hops.filter(trusted);
    for (const h of here) if (!cities.has(h.place)) cities.set(h.place, { place: h.place, lat: h.lat, lng: h.lng });
    if (isRiot(s.net) && here.length && !riot.has(here[0].place)) {
      const before = segs[i - 1]?.net;
      riot.set(here[0].place, { place: here[0].place, lat: here[0].lat, lng: here[0].lng, from: before && before.id !== "home" && !isRiot(before) ? before.name : null });
    }
  });
  return { cities: [...cities.values()], networks: [...networks.values()], riot: [...riot.values()] };
}
